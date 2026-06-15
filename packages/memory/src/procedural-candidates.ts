import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';

const log = getLogger('procedural-candidates');

export interface ProceduralCandidateRecord {
  id: string;
  compactionId: string;
  name: string;
  content: string;
  severity: 'info' | 'warn' | 'error';
  rationale: string;
  confidence: number;
  status: 'draft' | 'review' | 'approved' | 'active' | 'retired';
  supportingSessionIds: string[];
  rejectedAt?: string;
  rejectionReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProceduralCandidateInput {
  compactionId: string;
  name: string;
  content: string;
  severity?: 'info' | 'warn' | 'error';
  rationale?: string;
  confidence?: number;
  status?: 'draft' | 'review' | 'approved' | 'active' | 'retired';
  supportingSessionIds?: string[];
}

export interface UpsertProceduralCandidateInput {
  id?: string;
  compactionId: string;
  name: string;
  content?: string;
  severity?: 'info' | 'warn' | 'error';
  rationale?: string;
  confidence?: number;
  status?: 'draft' | 'review' | 'approved' | 'active' | 'retired';
  supportingSessionIds?: string[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS procedural_candidates (
  id TEXT PRIMARY KEY,
  compaction_id TEXT NOT NULL REFERENCES memory_compactions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  rationale TEXT NOT NULL DEFAULT '',
  confidence NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  supporting_session_ids TEXT[] NOT NULL DEFAULT '{}',
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

let _initialized = false;

export async function ensureProceduralCandidateStore(): Promise<void> {
  if (_initialized) return;
  await getDb().exec(SCHEMA);
  _initialized = true;
  log.info('Procedural candidate store initialized');
}

export async function createProceduralCandidate(
  input: CreateProceduralCandidateInput,
): Promise<ProceduralCandidateRecord> {
  await ensureProceduralCandidateStore();
  const db = getDb();
  const id = `pc-${input.compactionId}-${input.name.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 64)}`;

  const rows = await db.query<ProceduralCandidateRow>(
    `INSERT INTO procedural_candidates (id, compaction_id, name, content, severity, rationale, confidence, status, supporting_session_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      id, input.compactionId, input.name, input.content,
      input.severity ?? 'info', input.rationale ?? '',
      input.confidence ?? 0, input.status ?? 'draft',
      input.supportingSessionIds ?? [],
    ],
  );
  return rowToCandidate(rows.rows[0]!);
}

export async function upsertProceduralCandidate(
  input: UpsertProceduralCandidateInput,
): Promise<ProceduralCandidateRecord> {
  await ensureProceduralCandidateStore();
  const db = getDb();
  const id = input.id ?? `pc-${input.compactionId}-${input.name.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 64)}`;

  // Load existing to use as fallback for unspecified fields
  let existing: Partial<ProceduralCandidateRow> = {};
  try {
    existing = (await db.query<ProceduralCandidateRow>(
      'SELECT * FROM procedural_candidates WHERE id = $1', [id],
    )).rows[0] ?? {};
  } catch { /* first insert */ }

  const rows = await db.query<ProceduralCandidateRow>(
    `INSERT INTO procedural_candidates (id, compaction_id, name, content, severity, rationale, confidence, status, supporting_session_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       content = COALESCE($4, procedural_candidates.content),
       severity = COALESCE($5, procedural_candidates.severity),
       rationale = COALESCE($6, procedural_candidates.rationale),
       confidence = COALESCE($7, procedural_candidates.confidence),
       status = COALESCE($8, procedural_candidates.status),
       supporting_session_ids = COALESCE($9, procedural_candidates.supporting_session_ids),
       updated_at = now()
     RETURNING *`,
    [
      id, input.compactionId, input.name,
      input.content ?? existing.content ?? null,
      input.severity ?? existing.severity ?? 'info',
      input.rationale ?? existing.rationale ?? '',
      input.confidence ?? existing.confidence ?? 0,
      input.status ?? existing.status ?? 'draft',
      input.supportingSessionIds ?? existing.supporting_session_ids ?? [],
    ],
  );
  return rowToCandidate(rows.rows[0]!);
}

export async function promoteCandidate(
  id: string,
  newStatus: 'approved' | 'active' | 'retired',
  rejectedReason?: string,
): Promise<ProceduralCandidateRecord | null> {
  await ensureProceduralCandidateStore();
  const db = getDb();

  const updates: string[] = ['status = $2', 'updated_at = now()'];
  const params: unknown[] = [id, newStatus];

  if (newStatus === 'retired' && rejectedReason) {
    params.push(rejectedReason);
    updates.push(`rejection_reason = $${params.length}`);
    params.push(new Date().toISOString());
    updates.push(`rejected_at = $${params.length}`);
  }

  const rows = await db.query<ProceduralCandidateRow>(
    `UPDATE procedural_candidates SET ${updates.join(', ')} WHERE id = $1 RETURNING *`,
    params,
  );
  if (!rows.rows[0]) return null;
  return rowToCandidate(rows.rows[0]);
}

export async function listProceduralCandidates(
  options: {
    compactionId?: string;
    status?: string | string[];
    limit?: number;
  } = {},
): Promise<ProceduralCandidateRecord[]> {
  await ensureProceduralCandidateStore();
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.compactionId) {
    params.push(options.compactionId);
    clauses.push(`compaction_id = $${params.length}`);
  }
  if (options.status) {
    const statuses = Array.isArray(options.status) ? options.status : [options.status];
    params.push(statuses);
    clauses.push(`status = ANY($${params.length})`);
  }

  const limit = Math.max(1, Math.min(1000, options.limit ?? 100));
  params.push(limit);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = await db.query<ProceduralCandidateRow>(
    `SELECT * FROM procedural_candidates ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(rowToCandidate);
}

export async function loadProceduralCandidate(id: string): Promise<ProceduralCandidateRecord | null> {
  await ensureProceduralCandidateStore();
  const rows = await getDb().query<ProceduralCandidateRow>(
    'SELECT * FROM procedural_candidates WHERE id = $1', [id],
  );
  return rows.rows[0] ? rowToCandidate(rows.rows[0]) : null;
}

type ProceduralCandidateRow = {
  id: string;
  compaction_id: string;
  name: string;
  content: string;
  severity: string;
  rationale: string;
  confidence: string | number;
  status: string;
  supporting_session_ids: string[] | string;
  rejected_at: string | null;
  rejection_reason: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function rowToCandidate(row: ProceduralCandidateRow): ProceduralCandidateRecord {
  return {
    id: row.id,
    compactionId: row.compaction_id,
    name: row.name,
    content: row.content,
    severity: row.severity as ProceduralCandidateRecord['severity'],
    rationale: row.rationale ?? '',
    confidence: Number(row.confidence),
    status: row.status as ProceduralCandidateRecord['status'],
    supportingSessionIds: Array.isArray(row.supporting_session_ids)
      ? row.supporting_session_ids
      : typeof row.supporting_session_ids === 'string'
        ? row.supporting_session_ids.replace(/[{}]/g, '').split(',').filter(Boolean)
        : [],
    rejectedAt: row.rejected_at ?? undefined,
    rejectionReason: row.rejection_reason ?? undefined,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}
