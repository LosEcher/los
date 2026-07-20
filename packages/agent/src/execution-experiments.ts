import { getDb } from '@los/infra/db';
import { validateExecutionExperimentRequest, type ExecutionExperimentRequest } from '@los/contracts/execution-experiment';
import { transitionExecutionState } from './execution-store.js';

export type ExecutionExperimentStatus = ExecutionExperimentRequest['status'];
export type ExecutionExperimentSource = ExecutionExperimentRequest['source'];
export type ExecutionExperimentConfigDiff = ExecutionExperimentRequest['configDiff'][number];

export interface ExecutionExperimentRecord {
  id: string;
  tenantId?: string;
  projectId?: string;
  source: ExecutionExperimentSource;
  configDiff: ExecutionExperimentConfigDiff[];
  candidateRunSpecId?: string;
  status: ExecutionExperimentStatus;
  createdBy: string;
  approvedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateExecutionExperimentInput {
  id: string;
  tenantId?: string;
  projectId?: string;
  source: ExecutionExperimentSource;
  configDiff: ExecutionExperimentConfigDiff[];
  createdBy: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS execution_experiments (
  id TEXT PRIMARY KEY, tenant_id TEXT, project_id TEXT,
  source_session_id TEXT NOT NULL, source_run_spec_id TEXT NOT NULL,
  source_event_cursor BIGINT NOT NULL, source_evidence_hash TEXT NOT NULL,
  source_fingerprint_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  config_diff_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  candidate_run_spec_id TEXT, status TEXT NOT NULL DEFAULT 'draft',
  created_by TEXT NOT NULL, approved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT execution_experiments_source_event_cursor_check CHECK (source_event_cursor >= 0),
  CONSTRAINT execution_experiments_status_chk CHECK (status IN ('draft', 'approved', 'running', 'succeeded', 'failed', 'cancelled', 'blocked'))
);`;
let initialized = false;

export async function ensureExecutionExperimentStore(): Promise<void> {
  if (initialized) return;
  await getDb().exec(SCHEMA);
  await getDb().exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_experiments_candidate_run
      ON execution_experiments(candidate_run_spec_id) WHERE candidate_run_spec_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_execution_experiments_source
      ON execution_experiments(source_run_spec_id, source_event_cursor);
    CREATE INDEX IF NOT EXISTS idx_execution_experiments_status
      ON execution_experiments(status, updated_at DESC);
  `);
  initialized = true;
}

export async function createExecutionExperiment(input: CreateExecutionExperimentInput): Promise<ExecutionExperimentRecord> {
  const request: ExecutionExperimentRequest = { ...input, status: 'draft' };
  const validation = validateExecutionExperimentRequest(request);
  if (!validation.success) throw new Error(`execution-experiment contract validation failed: ${validation.errors.map(error => error.message ?? 'invalid').join('; ')}`);
  await ensureExecutionExperimentStore();
  const rows = await getDb().query<ExperimentRow>(
    `INSERT INTO execution_experiments
      (id, tenant_id, project_id, source_session_id, source_run_spec_id, source_event_cursor,
       source_evidence_hash, source_fingerprint_json, config_diff_json, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10) RETURNING *`,
    [input.id, input.tenantId ?? null, input.projectId ?? null, input.source.sessionId, input.source.runSpecId,
      input.source.eventCursor, input.source.evidenceHash, JSON.stringify(input.source.fingerprint ?? {}),
      JSON.stringify(input.configDiff), input.createdBy],
  );
  return rowToRecord(rows.rows[0]);
}

export async function loadExecutionExperiment(id: string): Promise<ExecutionExperimentRecord | null> {
  await ensureExecutionExperimentStore();
  const rows = await getDb().query<ExperimentRow>('SELECT * FROM execution_experiments WHERE id = $1', [id]);
  return rows.rows[0] ? rowToRecord(rows.rows[0]) : null;
}

export async function setExecutionExperimentCandidate(id: string, candidateRunSpecId: string): Promise<ExecutionExperimentRecord> {
  await ensureExecutionExperimentStore();
  const rows = await getDb().query<ExperimentRow>(
    `UPDATE execution_experiments SET candidate_run_spec_id = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, candidateRunSpecId],
  );
  if (!rows.rows[0]) throw new Error(`Execution experiment not found: ${id}`);
  return rowToRecord(rows.rows[0]);
}

export async function approveExecutionExperiment(id: string, actor: string): Promise<ExecutionExperimentRecord> {
  const current = await loadExecutionExperiment(id);
  if (!current) throw new Error(`Execution experiment not found: ${id}`);
  await transitionExecutionState({ entityType: 'execution_experiment', entityId: id, to: 'approved', sessionId: current.source.sessionId, reason: 'operator_approved_experiment', source: 'los.experiment', correlationId: actor });
  await getDb().query('UPDATE execution_experiments SET approved_by = $2, updated_at = now() WHERE id = $1', [id, actor]);
  const updated = await loadExecutionExperiment(id);
  if (!updated) throw new Error(`Execution experiment disappeared: ${id}`);
  return { ...updated, approvedBy: actor };
}

export async function transitionExecutionExperiment(id: string, to: Exclude<ExecutionExperimentStatus, 'draft' | 'approved'>, reason: string): Promise<ExecutionExperimentRecord> {
  const current = await loadExecutionExperiment(id);
  if (!current) throw new Error(`Execution experiment not found: ${id}`);
  await transitionExecutionState({ entityType: 'execution_experiment', entityId: id, to, sessionId: current.source.sessionId, reason, source: 'los.experiment' });
  const updated = await loadExecutionExperiment(id);
  if (!updated) throw new Error(`Execution experiment disappeared: ${id}`);
  return updated;
}

type ExperimentRow = {
  id: string; tenant_id: string | null; project_id: string | null;
  source_session_id: string; source_run_spec_id: string; source_event_cursor: number | string;
  source_evidence_hash: string; source_fingerprint_json: unknown; config_diff_json: unknown;
  candidate_run_spec_id: string | null; status: ExecutionExperimentStatus; created_by: string;
  approved_by: string | null; created_at: Date | string; updated_at: Date | string;
};

function rowToRecord(row: ExperimentRow): ExecutionExperimentRecord {
  return {
    id: row.id, tenantId: row.tenant_id ?? undefined, projectId: row.project_id ?? undefined,
    source: { sessionId: row.source_session_id, runSpecId: row.source_run_spec_id, eventCursor: Number(row.source_event_cursor), evidenceHash: row.source_evidence_hash, fingerprint: asRecord(row.source_fingerprint_json) as ExecutionExperimentSource['fingerprint'] },
    configDiff: Array.isArray(row.config_diff_json) ? row.config_diff_json as ExecutionExperimentConfigDiff[] : [],
    candidateRunSpecId: row.candidate_run_spec_id ?? undefined, status: row.status, createdBy: row.created_by,
    approvedBy: row.approved_by ?? undefined, createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at),
  };
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function toIso(value: Date | string): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
