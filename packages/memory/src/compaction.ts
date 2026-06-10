/**
 * @los/memory/compaction — Session memory compaction per ADR 0020.
 *
 * Compacts session observations, task runs, and eval records into a
 * structured summary. Procedural candidates are stored for review but
 * are never automatically promoted to rules.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';

const log = getLogger('memory-compaction');

export type CandidateStatus = 'draft' | 'review' | 'approved' | 'active' | 'retired';

export interface MemoryCompaction {
  id: string;
  sessionId: string;
  runSpecId?: string;
  tenantId?: string;
  projectId?: string;
  summary: Record<string, unknown>;
  observedPatterns: Record<string, unknown>[];
  proceduralCandidates: ProceduralCandidate[];
  confidence: number;
  /** Number of distinct sessions that support these patterns (cross-session). */
  evidenceCount: number;
  createdBy?: string;
  createdAt: string;
  /** Operator attestation — when a human confirms the pattern is valid. */
  attestedAt?: string;
  attestedBy?: string;
}

export interface ProceduralCandidate {
  name: string;
  content: string;
  severity: 'info' | 'warn' | 'error';
  rationale: string;
  confidence: number;
  status: CandidateStatus;
  /** Session IDs that also observed this pattern. */
  supportingSessionIds: string[];
}

export interface CompactSessionInput {
  sessionId: string;
  runSpecId?: string;
  tenantId?: string;
  projectId?: string;
  createdBy?: string;
}

export interface ListCompactionsOptions {
  sessionId?: string;
  runSpecId?: string;
  tenantId?: string;
  projectId?: string;
  limit?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_compactions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_spec_id TEXT,
  tenant_id TEXT,
  project_id TEXT,
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_patterns_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  procedural_candidates_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence NUMERIC NOT NULL DEFAULT 0,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE memory_compactions ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE memory_compactions ADD COLUMN IF NOT EXISTS project_id TEXT;

CREATE INDEX IF NOT EXISTS idx_memcomp_session ON memory_compactions(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memcomp_run_spec ON memory_compactions(run_spec_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memcomp_tenant_project ON memory_compactions(tenant_id, project_id, created_at DESC);
`;

let _initialized = false;

export async function ensureMemoryCompactionStore(): Promise<void> {
  if (_initialized) return;
  await getDb().exec(SCHEMA);
  _initialized = true;
  log.info('Memory compaction store initialized');
}

/**
 * Search existing compactions across other sessions for matching observed patterns.
 * Returns the number of distinct sessions that observed each pattern kind.
 */
async function lookupCrossSessionEvidence(
  sessionId: string,
  patternKinds: string[],
): Promise<Map<string, number>> {
  if (patternKinds.length === 0) return new Map();
  await ensureMemoryCompactionStore();
  const db = getDb();
  const counts = new Map<string, number>();

  for (const kind of patternKinds) {
    const rows = await db.query<{ cnt: string }>(
      `SELECT COUNT(DISTINCT session_id)::text AS cnt
       FROM memory_compactions
       WHERE session_id != $1
         AND observed_patterns_json @> $2::jsonb`,
      [sessionId, JSON.stringify([{ kind }])],
    );
    const count = Number(rows.rows[0]?.cnt ?? 0);
    if (count > 0) counts.set(kind, count);
  }
  return counts;
}

export async function compactSession(input: CompactSessionInput): Promise<MemoryCompaction> {
  await ensureMemoryCompactionStore();
  const sessionId = normalizeRequired(input.sessionId, 'sessionId');
  const db = getDb();

  // Parallelize independent data-gathering queries (different tables)
  const [obsRows, taskRows, evalRows] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM observations WHERE session_id = $1`,
      [sessionId],
    ),
    db.query<{ count: string; statuses: string }>(
      `SELECT
         COUNT(*)::text AS count,
         COALESCE(jsonb_agg(jsonb_build_object('id', id, 'status', status, 'model', model, 'node_id', node_id)), '[]'::jsonb)::text AS statuses
       FROM task_runs WHERE session_id = $1`,
      [sessionId],
    ),
    db.query<{ count: string; summary: string }>(
      `SELECT
         COUNT(*)::text AS count,
         COALESCE(jsonb_agg(jsonb_build_object(
           'success', success,
           'failure_class', failure_class,
           'failover_scope', failover_scope,
           'verification_status', verification_status
         )), '[]'::jsonb)::text AS summary
       FROM run_evals WHERE session_id = $1`,
      [sessionId],
    ),
  ]);
  const observationCount = Number(obsRows.rows[0]?.count ?? 0);
  const taskRunCount = Number(taskRows.rows[0]?.count ?? 0);
  const taskRunStatuses = parseJsonArray(taskRows.rows[0]?.statuses);
  const evalCount = Number(evalRows.rows[0]?.count ?? 0);
  const evalSummaries = parseJsonArray(evalRows.rows[0]?.summary);

  // Detect failover patterns
  const executorFailures = evalSummaries.filter(
    (e: Record<string, unknown>) => e.failover_scope === 'executor',
  ).length;

  // Build observed patterns
  const observedPatterns: Record<string, unknown>[] = [];
  if (executorFailures > 0) {
    observedPatterns.push({
      kind: 'executor_failover',
      count: executorFailures,
      description: `Session had ${executorFailures} executor-level failures`,
    });
  }

  // Look up cross-session evidence for observed pattern kinds
  const patternKinds = observedPatterns.map(p => String(p.kind ?? ''));
  const crossSessionCounts = await lookupCrossSessionEvidence(sessionId, patternKinds);

  // Count distinct evidence sources (source categories within session + cross-session)
  let evidenceCount = 0;
  if (observationCount > 0) evidenceCount += 1;
  if (taskRunCount > 0) evidenceCount += 1;
  if (evalCount > 0) evidenceCount += 1;
  // Cross-session evidence: count distinct sessions that support the same patterns
  for (const [kind, count] of crossSessionCounts.entries()) {
    // Each cross-session match adds 1 to evidence count (distinct session)
    evidenceCount += count;
  }

  const summary = {
    sessionId,
    runSpecId: input.runSpecId ?? null,
    tenantId: input.tenantId ?? null,
    projectId: input.projectId ?? null,
    observationCount,
    taskRunCount,
    evalCount,
    taskRunStatuses,
    evalSummaries,
    compactedAt: new Date().toISOString(),
  };

  // Build procedural candidates with cross-session evidence
  const proceduralCandidates: ProceduralCandidate[] = [];
  if (executorFailures > 0) {
    const crossSessions = crossSessionCounts.get('executor_failover') ?? 0;
    const totalSupporting = [sessionId];
    // Note: we could query for actual supporting session IDs here for full traceability
    proceduralCandidates.push({
      name: `executor-failover-alert-${sessionId.slice(0, 8)}`,
      content: `Session ${sessionId} experienced ${executorFailures} executor failures. Review executor node health.`,
      severity: 'warn',
      rationale: `Observed ${executorFailures} executor failover eval(s) in this session${crossSessions > 0 ? ` and ${crossSessions} other session(s)` : ''}.`,
      confidence: crossSessions >= 2 ? 0.7 : 0.5,
      status: crossSessions >= 2 ? 'review' : 'draft',
      supportingSessionIds: totalSupporting,
    });
  }

  const confidence = proceduralCandidates.length > 0
    ? Math.max(...proceduralCandidates.map(c => c.confidence))
    : 0;

  const id = `memcomp-${sessionId}-${randomUUID()}`;
  const rows = await db.query<CompactionRow>(
    `
    INSERT INTO memory_compactions (
      id, session_id, run_spec_id, tenant_id, project_id, summary_json, observed_patterns_json,
      procedural_candidates_json, confidence, evidence_count, created_by
    )
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11)
    RETURNING *
  `,
    [
      id,
      sessionId,
      input.runSpecId ?? null,
      input.tenantId ?? null,
      input.projectId ?? null,
      JSON.stringify(summary),
      JSON.stringify(observedPatterns),
      JSON.stringify(proceduralCandidates),
      confidence,
      evidenceCount,
      input.createdBy ?? null,
    ],
  );

  return rowToCompaction(assertRow(rows.rows[0]));
}

/**
 * Add operator attestation to a compaction. Confirms that the observed
 * patterns are valid and the procedural candidates should be promoted.
 */
export async function attestCompaction(
  id: string,
  attestedBy: string,
): Promise<MemoryCompaction | null> {
  await ensureMemoryCompactionStore();
  const db = getDb();
  const rows = await db.query<CompactionRow>(
    `UPDATE memory_compactions
     SET created_by = COALESCE(created_by, $2)
     WHERE id = $1
     RETURNING *`,
    [id, attestedBy],
  );
  // Note: attestedAt/attestedBy stored in summary_json for queryability
  if (rows.rows[0]) {
    const existing = rowToCompaction(rows.rows[0]);
    const updatedSummary = {
      ...existing.summary,
      attestedAt: new Date().toISOString(),
      attestedBy,
    };
    await db.query(
      `UPDATE memory_compactions SET summary_json = $2::jsonb WHERE id = $1`,
      [id, JSON.stringify(updatedSummary)],
    );
    return { ...existing, summary: updatedSummary, attestedAt: updatedSummary.attestedAt as string, attestedBy };
  }
  return null;
}

/**
 * Promote a procedural candidate within a compaction from draft → review → approved → active.
 */
export async function promoteCandidate(
  compactionId: string,
  candidateName: string,
  newStatus: CandidateStatus,
): Promise<MemoryCompaction | null> {
  await ensureMemoryCompactionStore();
  const compaction = await getCompaction(compactionId);
  if (!compaction) return null;

  const candidates = compaction.proceduralCandidates.map(c =>
    c.name === candidateName ? { ...c, status: newStatus } : c,
  );

  const db = getDb();
  await db.query(
    `UPDATE memory_compactions SET procedural_candidates_json = $2::jsonb WHERE id = $1`,
    [compactionId, JSON.stringify(candidates)],
  );

  return await getCompaction(compactionId);
}

export async function getCompaction(id: string): Promise<MemoryCompaction | null> {
  await ensureMemoryCompactionStore();
  const rows = await getDb().query<CompactionRow>(
    'SELECT * FROM memory_compactions WHERE id = $1',
    [id],
  );
  return rows.rows[0] ? rowToCompaction(rows.rows[0]) : null;
}

export async function listCompactions(options: ListCompactionsOptions = {}): Promise<MemoryCompaction[]> {
  await ensureMemoryCompactionStore();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.sessionId) {
    params.push(options.sessionId);
    clauses.push(`session_id = $${params.length}`);
  }
  if (options.runSpecId) {
    params.push(options.runSpecId);
    clauses.push(`run_spec_id = $${params.length}`);
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

  const rows = await getDb().query<CompactionRow>(
    `
    SELECT * FROM memory_compactions
    ${where}
    ORDER BY created_at DESC, id
    LIMIT $${params.length}
  `,
    params,
  );

  return rows.rows.map(rowToCompaction);
}

type CompactionRow = {
  id: string;
  session_id: string;
  run_spec_id: string | null;
  tenant_id: string | null;
  project_id: string | null;
  summary_json: unknown;
  observed_patterns_json: unknown;
  procedural_candidates_json: unknown;
  confidence: string | number;
  evidence_count: string | number;
  created_by: string | null;
  created_at: Date | string;
};

function rowToCompaction(row: CompactionRow): MemoryCompaction {
  const summary = normalizeJsonObject(row.summary_json);
  return {
    id: row.id,
    sessionId: row.session_id,
    runSpecId: row.run_spec_id ?? undefined,
    tenantId: row.tenant_id ?? undefined,
    projectId: row.project_id ?? undefined,
    summary,
    observedPatterns: normalizeJsonArray(row.observed_patterns_json),
    proceduralCandidates: normalizeCandidateArray(row.procedural_candidates_json),
    confidence: Number(row.confidence),
    evidenceCount: Number(row.evidence_count),
    createdBy: row.created_by ?? undefined,
    createdAt: toIsoString(row.created_at),
    attestedAt: typeof summary.attestedAt === 'string' ? summary.attestedAt : undefined,
    attestedBy: typeof summary.attestedBy === 'string' ? summary.attestedBy : undefined,
  };
}

function normalizeCandidateArray(value: unknown): ProceduralCandidate[] {
  const raw = normalizeJsonArray(value);
  return raw.map((item: Record<string, unknown>): ProceduralCandidate => ({
    name: typeof item.name === 'string' ? item.name : 'unknown',
    content: typeof item.content === 'string' ? item.content : '',
    severity: (item.severity === 'info' || item.severity === 'warn' || item.severity === 'error')
      ? item.severity as 'info' | 'warn' | 'error' : 'info',
    rationale: typeof item.rationale === 'string' ? item.rationale : '',
    confidence: typeof item.confidence === 'number' ? item.confidence : 0,
    status: (item.status === 'draft' || item.status === 'review' || item.status === 'approved' || item.status === 'active' || item.status === 'retired')
      ? item.status as CandidateStatus : 'draft',
    supportingSessionIds: Array.isArray(item.supportingSessionIds)
      ? item.supportingSessionIds.filter((s): s is string => typeof s === 'string')
      : [],
  }));
}

function normalizeRequired(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function normalizeLimit(value: unknown): number {
  const parsed = Number(value ?? 100);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.max(1, Math.min(1000, Math.floor(parsed)));
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

function normalizeJsonArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(v => normalizeJsonObject(v));
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map((v: unknown) => normalizeJsonObject(v)) : [];
    } catch { return []; }
  }
  return [];
}

function parseJsonArray(raw: string | undefined): Record<string, unknown>[] {
  if (!raw) return [];
  try { return JSON.parse(raw) as Record<string, unknown>[]; } catch { return []; }
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('compaction write returned no row');
  return row;
}
