import { getDb } from '@los/infra/db';

export type RunEvalVerificationStatus =
  | 'unknown'
  | 'not_required'
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'skipped';

export interface RunEvalRecord {
  id: string;
  runSpecId: string;
  sessionId?: string;
  taskRunId?: string;
  provider?: string;
  model?: string;
  success: boolean;
  latencyMs?: number;
  retryCount: number;
  toolErrorCount: number;
  verificationStatus: RunEvalVerificationStatus;
  modelCost?: number;
  userFeedback?: string;
  failureClass?: string;
  summary: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RecordRunEvalInput {
  id?: string;
  runSpecId: string;
  sessionId?: string;
  taskRunId?: string;
  provider?: string;
  model?: string;
  success: boolean;
  latencyMs?: number;
  retryCount?: number;
  toolErrorCount?: number;
  verificationStatus?: RunEvalVerificationStatus | string;
  modelCost?: number;
  userFeedback?: string;
  failureClass?: string;
  summary?: Record<string, unknown>;
}

export interface ListRunEvalsOptions {
  runSpecId?: string;
  sessionId?: string;
  taskRunId?: string;
  provider?: string;
  model?: string;
  success?: boolean;
  verificationStatus?: RunEvalVerificationStatus | string;
  failureClass?: string;
  limit?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS run_evals (
  id TEXT PRIMARY KEY,
  run_spec_id TEXT NOT NULL,
  session_id TEXT,
  task_run_id TEXT,
  provider TEXT,
  model TEXT,
  success BOOLEAN NOT NULL,
  latency_ms INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  tool_error_count INTEGER NOT NULL DEFAULT 0,
  verification_status TEXT NOT NULL DEFAULT 'unknown',
  model_cost NUMERIC,
  user_feedback TEXT,
  failure_class TEXT,
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_run_evals_run_spec ON run_evals(run_spec_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_session ON run_evals(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_task_run ON run_evals(task_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_provider_model ON run_evals(provider, model, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_success ON run_evals(success, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_failure_class ON run_evals(failure_class, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_verification ON run_evals(verification_status, created_at DESC);
`;

let _initialized = false;

export async function ensureRunEvalStore(): Promise<void> {
  if (_initialized) return;
  await getDb().exec(SCHEMA);
  _initialized = true;
}

export async function recordRunEval(input: RecordRunEvalInput): Promise<RunEvalRecord> {
  await ensureRunEvalStore();
  const runSpecId = normalizeRequiredString(input.runSpecId, 'runSpecId');
  const id = normalizeOptionalString(input.id)
    ?? `run-eval-${runSpecId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const rows = await getDb().query<RunEvalRow>(
    `
    INSERT INTO run_evals (
      id, run_spec_id, session_id, task_run_id, provider, model, success,
      latency_ms, retry_count, tool_error_count, verification_status,
      model_cost, user_feedback, failure_class, summary_json
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11,
      $12, $13, $14, $15::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      run_spec_id = EXCLUDED.run_spec_id,
      session_id = EXCLUDED.session_id,
      task_run_id = EXCLUDED.task_run_id,
      provider = EXCLUDED.provider,
      model = EXCLUDED.model,
      success = EXCLUDED.success,
      latency_ms = EXCLUDED.latency_ms,
      retry_count = EXCLUDED.retry_count,
      tool_error_count = EXCLUDED.tool_error_count,
      verification_status = EXCLUDED.verification_status,
      model_cost = EXCLUDED.model_cost,
      user_feedback = EXCLUDED.user_feedback,
      failure_class = EXCLUDED.failure_class,
      summary_json = EXCLUDED.summary_json,
      updated_at = now()
    RETURNING *
  `,
    [
      id,
      runSpecId,
      normalizeOptionalString(input.sessionId) ?? null,
      normalizeOptionalString(input.taskRunId) ?? null,
      normalizeOptionalString(input.provider) ?? null,
      normalizeOptionalString(input.model) ?? null,
      Boolean(input.success),
      normalizeOptionalNonNegativeInteger(input.latencyMs) ?? null,
      normalizeNonNegativeInteger(input.retryCount, 0),
      normalizeNonNegativeInteger(input.toolErrorCount, 0),
      normalizeVerificationStatus(input.verificationStatus),
      normalizeOptionalNonNegativeNumber(input.modelCost) ?? null,
      normalizeOptionalString(input.userFeedback) ?? null,
      normalizeOptionalString(input.failureClass) ?? null,
      JSON.stringify(normalizeJsonObject(input.summary)),
    ],
  );
  return rowToRecord(assertRow(rows.rows[0]));
}

export async function listRunEvals(options: ListRunEvalsOptions = {}): Promise<RunEvalRecord[]> {
  await ensureRunEvalStore();
  const clauses: string[] = [];
  const params: unknown[] = [];
  addOptionalClause(clauses, params, 'run_spec_id', normalizeOptionalString(options.runSpecId));
  addOptionalClause(clauses, params, 'session_id', normalizeOptionalString(options.sessionId));
  addOptionalClause(clauses, params, 'task_run_id', normalizeOptionalString(options.taskRunId));
  addOptionalClause(clauses, params, 'provider', normalizeOptionalString(options.provider));
  addOptionalClause(clauses, params, 'model', normalizeOptionalString(options.model));
  addOptionalClause(clauses, params, 'verification_status', normalizeOptionalString(options.verificationStatus));
  addOptionalClause(clauses, params, 'failure_class', normalizeOptionalString(options.failureClass));
  if (typeof options.success === 'boolean') {
    params.push(options.success);
    clauses.push(`success = $${params.length}`);
  }
  params.push(normalizeLimit(options.limit));
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await getDb().query<RunEvalRow>(
    `
    SELECT *
    FROM run_evals
    ${where}
    ORDER BY created_at DESC, id
    LIMIT $${params.length}
  `,
    params,
  );
  return rows.rows.map(rowToRecord);
}

function addOptionalClause(clauses: string[], params: unknown[], column: string, value: string | undefined): void {
  if (!value) return;
  params.push(value);
  clauses.push(`${column} = $${params.length}`);
}

type RunEvalRow = {
  id: string;
  run_spec_id: string;
  session_id: string | null;
  task_run_id: string | null;
  provider: string | null;
  model: string | null;
  success: boolean;
  latency_ms: number | null;
  retry_count: number;
  tool_error_count: number;
  verification_status: string;
  model_cost: string | number | null;
  user_feedback: string | null;
  failure_class: string | null;
  summary_json: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

function rowToRecord(row: RunEvalRow): RunEvalRecord {
  return {
    id: row.id,
    runSpecId: row.run_spec_id,
    sessionId: row.session_id ?? undefined,
    taskRunId: row.task_run_id ?? undefined,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    success: row.success,
    latencyMs: row.latency_ms ?? undefined,
    retryCount: row.retry_count,
    toolErrorCount: row.tool_error_count,
    verificationStatus: normalizeVerificationStatus(row.verification_status),
    modelCost: row.model_cost === null ? undefined : Number(row.model_cost),
    userFeedback: row.user_feedback ?? undefined,
    failureClass: row.failure_class ?? undefined,
    summary: normalizeJsonObject(row.summary_json),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function normalizeVerificationStatus(value: unknown): RunEvalVerificationStatus {
  if (
    value === 'not_required'
    || value === 'pending'
    || value === 'succeeded'
    || value === 'failed'
    || value === 'skipped'
  ) {
    return value;
  }
  return 'unknown';
}

function normalizeRequiredString(value: unknown, name: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeNonNegativeInteger(value: unknown, defaultValue: number): number {
  const parsed = Number(value ?? defaultValue);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultValue;
  return Math.floor(parsed);
}

function normalizeOptionalNonNegativeInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('integer metric must be non-negative');
  return Math.floor(parsed);
}

function normalizeOptionalNonNegativeNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('numeric metric must be non-negative');
  return parsed;
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
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
  if (!row) throw new Error('run eval write returned no row');
  return row;
}
