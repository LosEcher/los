/**
 * @los/memory/procedural-candidates — Standalone procedural_candidates table.
 *
 * Extracted from memory_compactions.procedural_candidates_json JSONB column
 * for queryability, promotion tracking, and session event emission.
 */

import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import { PROCEDURAL_CANDIDATES_DDL } from '@los/infra/procedural-candidates-ddl';

const log = getLogger('procedural-candidates');

export type CandidateStatus = 'draft' | 'review' | 'approved' | 'active' | 'retired';

export interface ProceduralCandidate {
  id: string;
  name: string;
  content: string;
  severity: 'info' | 'warn' | 'error';
  rationale: string;
  confidence: number;
  status: CandidateStatus;
  compactionId: string;
  sessionId: string;
  tenantId?: string;
  projectId?: string;
  evidence: { supportingSessionIds: string[] };
  createdAt: string;
  updatedAt: string;
}

export interface CreateProceduralCandidateInput {
  name: string;
  content: string;
  severity?: 'info' | 'warn' | 'error';
  rationale?: string;
  confidence?: number;
  status?: CandidateStatus;
  compactionId: string;
  sessionId: string;
  tenantId?: string;
  projectId?: string;
  supportingSessionIds?: string[];
}

export interface ListProceduralCandidatesOptions {
  status?: CandidateStatus;
  compactionId?: string;
  sessionId?: string;
  tenantId?: string;
  projectId?: string;
  name?: string;
  limit?: number;
}

let _initialized = false;

export async function ensureProceduralCandidateStore(): Promise<void> {
  if (_initialized) return;
  await getDb().exec(PROCEDURAL_CANDIDATES_DDL);
  _initialized = true;
  log.info('Procedural candidate store initialized');
}

export async function createProceduralCandidate(
  input: CreateProceduralCandidateInput,
): Promise<ProceduralCandidate> {
  await ensureProceduralCandidateStore();
  const db = getDb();

  const id = `pc-${input.compactionId}-${input.name.slice(0, 64)}`;
  const evidence = {
    supportingSessionIds: input.supportingSessionIds ?? [input.sessionId],
  };

  const rows = await db.query<CandidateRow>(
    `INSERT INTO procedural_candidates (
      id, name, content, severity, rationale, confidence, status,
      compaction_id, session_id, tenant_id, project_id, evidence_json
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
    RETURNING *`,
    [
      id,
      input.name,
      input.content,
      input.severity ?? 'info',
      input.rationale ?? '',
      input.confidence ?? 0.5,
      input.status ?? 'draft',
      input.compactionId,
      input.sessionId,
      input.tenantId ?? null,
      input.projectId ?? null,
      JSON.stringify(evidence),
    ],
  );

  return rowToCandidate(assertRow(rows.rows[0]));
}

export async function getProceduralCandidate(id: string): Promise<ProceduralCandidate | null> {
  await ensureProceduralCandidateStore();
  const rows = await getDb().query<CandidateRow>(
    'SELECT * FROM procedural_candidates WHERE id = $1',
    [id],
  );
  return rows.rows[0] ? rowToCandidate(rows.rows[0]) : null;
}

export async function listProceduralCandidates(
  options: ListProceduralCandidatesOptions = {},
): Promise<ProceduralCandidate[]> {
  await ensureProceduralCandidateStore();
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.status) {
    params.push(options.status);
    clauses.push(`status = $${params.length}`);
  }
  if (options.compactionId) {
    params.push(options.compactionId);
    clauses.push(`compaction_id = $${params.length}`);
  }
  if (options.sessionId) {
    params.push(options.sessionId);
    clauses.push(`session_id = $${params.length}`);
  }
  if (options.name) {
    params.push(options.name);
    clauses.push(`name = $${params.length}`);
  }
  if (options.tenantId) {
    params.push(options.tenantId);
    clauses.push(`(tenant_id IS NULL OR tenant_id = $${params.length})`);
  }
  if (options.projectId) {
    params.push(options.projectId);
    clauses.push(`(project_id IS NULL OR project_id = $${params.length})`);
  }

  const limit = normalizeLimit(options.limit);
  params.push(limit);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = await db.query<CandidateRow>(
    `SELECT * FROM procedural_candidates
     ${where}
     ORDER BY created_at DESC, id
     LIMIT $${params.length}`,
    params,
  );

  return rows.rows.map(rowToCandidate);
}

export async function listActiveCandidates(options?: {
  tenantId?: string;
  projectId?: string;
  limit?: number;
}): Promise<ProceduralCandidate[]> {
  return listProceduralCandidates({
    status: 'active',
    tenantId: options?.tenantId,
    projectId: options?.projectId,
    limit: options?.limit,
  });
}

export async function promoteProceduralCandidate(
  id: string,
  newStatus: CandidateStatus,
): Promise<ProceduralCandidate | null> {
  await ensureProceduralCandidateStore();
  const existing = await getProceduralCandidate(id);
  if (!existing) return null;

  const db = getDb();

  const rows = await db.query<CandidateRow>(
    `UPDATE procedural_candidates
     SET status = $2, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, newStatus],
  );

  return rows.rows[0] ? rowToCandidate(rows.rows[0]) : null;
}

export async function deleteProceduralCandidate(id: string): Promise<boolean> {
  await ensureProceduralCandidateStore();
  const result = await getDb().query<{ id: string }>(
    'DELETE FROM procedural_candidates WHERE id = $1 RETURNING id',
    [id],
  );
  return result.rows.length > 0;
}

// ── Helpers ──────────────────────────────────────────────

type CandidateRow = {
  id: string;
  name: string;
  content: string;
  severity: string;
  rationale: string;
  confidence: string | number;
  status: string;
  compaction_id: string;
  session_id: string;
  tenant_id: string | null;
  project_id: string | null;
  evidence_json: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

function rowToCandidate(row: CandidateRow): ProceduralCandidate {
  const evidence = normalizeJsonObject(row.evidence_json);
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    severity: normalizeSeverity(row.severity),
    rationale: row.rationale,
    confidence: Number(row.confidence),
    status: normalizeStatus(row.status),
    compactionId: row.compaction_id,
    sessionId: row.session_id,
    tenantId: row.tenant_id ?? undefined,
    projectId: row.project_id ?? undefined,
    evidence: {
      supportingSessionIds: Array.isArray(evidence.supportingSessionIds)
        ? evidence.supportingSessionIds.filter((s): s is string => typeof s === 'string')
        : [],
    },
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function normalizeSeverity(value: string): 'info' | 'warn' | 'error' {
  if (value === 'error' || value === 'warn' || value === 'info') return value;
  return 'info';
}

function normalizeStatus(value: string): CandidateStatus {
  const valid: CandidateStatus[] = ['draft', 'review', 'approved', 'active', 'retired'];
  return valid.includes(value as CandidateStatus) ? (value as CandidateStatus) : 'draft';
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { return {}; }
  }
  return {};
}

function normalizeLimit(value: unknown): number {
  const parsed = Number(value ?? 100);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.max(1, Math.min(1000, Math.floor(parsed)));
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('procedural_candidates write returned no row');
  return row;
}
