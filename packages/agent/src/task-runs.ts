/**
 * @los/agent/task-runs — Minimal persistent task lifecycle records.
 *
 * This is the project-task layer above chat sessions:
 * queued -> running -> succeeded/failed/cancelled
 */

import { getDb, withDbClient } from '@los/infra/db';
import { mergeRunContractMetadata, type RunContractMetadataInput } from './run-contract.js';

export type TaskRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export const TASK_RUN_STARTUP_RECOVERY_LOCK_KEY = 7_602_026_001;

export interface TaskRunRecord {
  id: string;
  sessionId: string;
  runSpecId?: string;
  traceId: string;
  dedupeKey?: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  nodeId?: string;
  requestId?: string;
  workspaceRoot: string;
  toolMode: string;
  provider?: string;
  model?: string;
  status: TaskRunStatus;
  attempt: number;
  promptPreview: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  heartbeatAt?: string;
  leaseExpiresAt?: string;
}

export interface CreateTaskRunInput {
  id: string;
  sessionId: string;
  runSpecId?: string;
  traceId?: string;
  dedupeKey?: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  nodeId?: string;
  requestId?: string;
  workspaceRoot: string;
  toolMode: string;
  provider?: string;
  model?: string;
  promptPreview: string;
  metadata?: Record<string, unknown>;
  runContract?: RunContractMetadataInput;
  status?: TaskRunStatus;
  attempt?: number;
}

export interface UpdateTaskRunInput {
  status?: TaskRunStatus;
  metadata?: Record<string, unknown>;
  runContract?: RunContractMetadataInput | null;
  nodeId?: string | null;
  heartbeatAt?: Date | string | null;
  leaseExpiresAt?: Date | string | null;
}

export interface TaskRunRecoveryResult {
  lockAcquired: boolean;
  recovered: TaskRunRecord[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  trace_id TEXT,
  dedupe_key TEXT,
  tenant_id TEXT,
  project_id TEXT,
  user_id TEXT,
  node_id TEXT,
  request_id TEXT,
  workspace_root TEXT NOT NULL,
  tool_mode TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  prompt_preview TEXT NOT NULL DEFAULT '',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ
);

ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS trace_id TEXT;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS node_id TEXT;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS run_spec_id TEXT;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_task_runs_session_id ON task_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_trace_id ON task_runs(trace_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_dedupe_key ON task_runs(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_task_runs_tenant_project ON task_runs(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_node_id ON task_runs(node_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_request_id ON task_runs(request_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_lease ON task_runs(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);
CREATE INDEX IF NOT EXISTS idx_task_runs_updated ON task_runs(updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_active_dedupe
  ON task_runs(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');
`;

let _initialized = false;

export async function ensureTaskRunStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(SCHEMA);
  _initialized = true;
}

export async function createTaskRun(input: CreateTaskRunInput): Promise<TaskRunRecord> {
  await ensureTaskRunStore();
  const db = getDb();
  const rows = await db.query<TaskRunRow>(
    `
    INSERT INTO task_runs (
      id, session_id, run_spec_id, trace_id, dedupe_key, tenant_id, project_id, user_id, node_id, request_id,
      workspace_root, tool_mode, provider, model,
      status,
      attempt, prompt_preview, metadata_json, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, now())
    RETURNING *
  `,
    [
      input.id,
      input.sessionId,
      input.runSpecId ?? null,
      input.traceId ?? input.id,
      input.dedupeKey ?? null,
      input.tenantId ?? null,
      input.projectId ?? null,
      input.userId ?? null,
      input.nodeId ?? null,
      input.requestId ?? null,
      input.workspaceRoot,
      input.toolMode,
      input.provider ?? null,
      input.model ?? null,
      input.status ?? 'queued',
      input.attempt ?? 1,
      input.promptPreview,
      JSON.stringify(mergeRunContractMetadata(input.metadata, input.runContract)),
    ],
  );
  return rowToTaskRun(assertRow(rows.rows[0]));
}

export async function updateTaskRun(id: string, updates: UpdateTaskRunInput): Promise<TaskRunRecord | null> {
  await ensureTaskRunStore();
  const db = getDb();
  const existing = await loadTaskRun(id);
  if (!existing) return null;

  const status = updates.status ?? existing.status;
  const metadata = updates.runContract === undefined
    ? updates.metadata ?? existing.metadata
    : mergeRunContractMetadata(updates.metadata ?? existing.metadata, updates.runContract);
  const nodeId = updates.nodeId === undefined ? null : updates.nodeId;
  const heartbeatAt = updates.heartbeatAt === undefined ? null : updates.heartbeatAt;
  const leaseExpiresAt = updates.leaseExpiresAt === undefined ? null : updates.leaseExpiresAt;

  const rows = await db.query<TaskRunRow>(
    `
    UPDATE task_runs
    SET status = $2,
        metadata_json = $3::jsonb,
        node_id = COALESCE($4, node_id),
        heartbeat_at = COALESCE($5::timestamptz, heartbeat_at),
        lease_expires_at = CASE
          WHEN $6::timestamptz IS NULL AND $2 IN ('succeeded', 'failed', 'cancelled') THEN NULL
          ELSE COALESCE($6::timestamptz, lease_expires_at)
        END,
        updated_at = now(),
        started_at = CASE
          WHEN $2 = 'running' AND started_at IS NULL THEN now()
          ELSE started_at
        END,
        completed_at = CASE
          WHEN $2 IN ('succeeded', 'failed', 'cancelled') THEN now()
          ELSE completed_at
        END
    WHERE id = $1
    RETURNING *
  `,
    [id, status, JSON.stringify(metadata), nodeId, heartbeatAt, leaseExpiresAt],
  );
  return rows.rows[0] ? rowToTaskRun(rows.rows[0]) : null;
}

export async function heartbeatTaskRun(
  id: string,
  input: { nodeId?: string; leaseMs?: number } = {},
): Promise<TaskRunRecord | null> {
  await ensureTaskRunStore();
  const db = getDb();
  const leaseMs = normalizeLeaseMs(input.leaseMs);
  const rows = await db.query<TaskRunRow>(
    `
    UPDATE task_runs
    SET node_id = COALESCE($2, node_id),
        heartbeat_at = now(),
        lease_expires_at = now() + ($3::text || ' milliseconds')::interval,
        updated_at = now()
    WHERE id = $1
      AND status IN ('queued', 'running')
    RETURNING *
  `,
    [id, input.nodeId ?? null, leaseMs],
  );
  return rows.rows[0] ? rowToTaskRun(rows.rows[0]) : null;
}

export async function recoverExpiredTaskRuns(reason = 'lease_expired'): Promise<TaskRunRecord[]> {
  await ensureTaskRunStore();
  const db = getDb();
  const rows = await db.query<TaskRunRow>(
    `
    UPDATE task_runs
    SET status = 'failed',
        metadata_json = metadata_json || $1::jsonb,
        completed_at = now(),
        lease_expires_at = NULL,
        updated_at = now()
    WHERE status IN ('queued', 'running')
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < now()
    RETURNING *
  `,
    [JSON.stringify({ recoveryReason: reason })],
  );
  return rows.rows.map(rowToTaskRun);
}

export async function recoverExpiredTaskRunsWithAdvisoryLock(
  reason = 'lease_expired',
  lockKey = TASK_RUN_STARTUP_RECOVERY_LOCK_KEY,
): Promise<TaskRunRecoveryResult> {
  await ensureTaskRunStore();
  return await withDbClient(async (client) => {
    const lock = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
      [lockKey],
    );
    if (lock.rows[0]?.acquired !== true) {
      return {
        lockAcquired: false,
        recovered: [],
      };
    }

    try {
      const rows = await client.query<TaskRunRow>(
        `
        UPDATE task_runs
        SET status = 'failed',
            metadata_json = metadata_json || $1::jsonb,
            completed_at = now(),
            lease_expires_at = NULL,
            updated_at = now()
        WHERE status IN ('queued', 'running')
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < now()
        RETURNING *
      `,
        [JSON.stringify({ recoveryReason: reason })],
      );
      return {
        lockAcquired: true,
        recovered: rows.rows.map(rowToTaskRun),
      };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey]).catch(() => undefined);
    }
  });
}

export async function loadTaskRun(id: string): Promise<TaskRunRecord | null> {
  await ensureTaskRunStore();
  const db = getDb();
  const rows = await db.query<TaskRunRow>('SELECT * FROM task_runs WHERE id = $1', [id]);
  return rows.rows[0] ? rowToTaskRun(rows.rows[0]) : null;
}

export async function findActiveTaskRunByDedupeKey(dedupeKey: string): Promise<TaskRunRecord | null> {
  await ensureTaskRunStore();
  const normalized = dedupeKey.trim();
  if (!normalized) return null;

  const db = getDb();
  const rows = await db.query<TaskRunRow>(
    `
    SELECT *
    FROM task_runs
    WHERE dedupe_key = $1
      AND status IN ('queued', 'running')
    ORDER BY updated_at DESC
    LIMIT 1
  `,
    [normalized],
  );
  return rows.rows[0] ? rowToTaskRun(rows.rows[0]) : null;
}

export async function listTaskRuns(limit = 50): Promise<TaskRunRecord[]> {
  await ensureTaskRunStore();
  const db = getDb();
  const rows = await db.query<TaskRunRow>(
    'SELECT * FROM task_runs ORDER BY updated_at DESC LIMIT $1',
    [limit],
  );
  return rows.rows.map(rowToTaskRun);
}

export async function listTaskRunsForSession(sessionId: string, limit = 20): Promise<TaskRunRecord[]> {
  await ensureTaskRunStore();
  const db = getDb();
  const rows = await db.query<TaskRunRow>(
    `
    SELECT *
    FROM task_runs
    WHERE session_id = $1
    ORDER BY updated_at DESC
    LIMIT $2
  `,
    [sessionId, limit],
  );
  return rows.rows.map(rowToTaskRun);
}

export async function listTaskRunsForRunSpec(runSpecId: string): Promise<TaskRunRecord[]> {
  await ensureTaskRunStore();
  const db = getDb();
  const rows = await db.query<TaskRunRow>(
    `
    SELECT *
    FROM task_runs
    WHERE run_spec_id = $1
    ORDER BY created_at ASC, id ASC
  `,
    [runSpecId],
  );
  return rows.rows.map(rowToTaskRun);
}

type TaskRunRow = {
  id: string;
  session_id: string;
  run_spec_id: string | null;
  trace_id: string | null;
  dedupe_key: string | null;
  tenant_id: string | null;
  project_id: string | null;
  user_id: string | null;
  node_id: string | null;
  request_id: string | null;
  workspace_root: string;
  tool_mode: string;
  provider: string | null;
  model: string | null;
  status: TaskRunStatus;
  attempt: number | null;
  prompt_preview: string;
  metadata_json: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  heartbeat_at: Date | string | null;
  lease_expires_at: Date | string | null;
};

function rowToTaskRun(row: TaskRunRow): TaskRunRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    runSpecId: row.run_spec_id ?? undefined,
    traceId: row.trace_id ?? row.id,
    dedupeKey: row.dedupe_key ?? undefined,
    tenantId: row.tenant_id ?? undefined,
    projectId: row.project_id ?? undefined,
    userId: row.user_id ?? undefined,
    nodeId: row.node_id ?? undefined,
    requestId: row.request_id ?? undefined,
    workspaceRoot: row.workspace_root,
    toolMode: row.tool_mode,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    status: row.status,
    attempt: row.attempt ?? 1,
    promptPreview: row.prompt_preview,
    metadata: normalizeJsonObject(row.metadata_json),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    startedAt: row.started_at ? toIsoString(row.started_at) : undefined,
    completedAt: row.completed_at ? toIsoString(row.completed_at) : undefined,
    heartbeatAt: row.heartbeat_at ? toIsoString(row.heartbeat_at) : undefined,
    leaseExpiresAt: row.lease_expires_at ? toIsoString(row.lease_expires_at) : undefined,
  };
}

function normalizeLeaseMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 30_000;
  const int = Math.floor(value);
  return Math.max(1_000, Math.min(int, 10 * 60_000));
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertRow<T>(row: T | undefined): T {
  if (!row) {
    throw new Error('Failed to create task run');
  }
  return row;
}
