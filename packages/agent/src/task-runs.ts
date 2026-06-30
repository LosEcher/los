/**
 * @los/agent/task-runs — Minimal persistent task lifecycle records.
 *
 * This is the project-task layer above chat sessions:
 * queued -> running -> succeeded/failed/cancelled
 */

import { getDb, withDbClient } from '@los/infra/db';
import { resolveCoordinationBackend } from './coordination/resolve.js';
import { mergeRunContractMetadata, type RunContractMetadataInput } from './run-contract.js';
import { TASK_RUN_SCHEMA } from './task-runs/schema.js';
import { assertRow, normalizeLeaseMs } from './task-runs/normalizers.js';
import { rowToTaskRun, type TaskRunRow } from './task-runs/rows.js';

export type TaskRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'blocked';

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

export interface UpdateTaskRunFieldsInput {
  metadata?: Record<string, unknown>;
  runContract?: RunContractMetadataInput | null;
  nodeId?: string | null;
  heartbeatAt?: Date | string | null;
  leaseExpiresAt?: Date | string | null;
  attempt?: number;
}

export interface UpdateTaskRunInput extends UpdateTaskRunFieldsInput {
  status?: TaskRunStatus;
}

export interface TaskRunRecoveryResult {
  lockAcquired: boolean;
  recovered: TaskRunRecord[];
}

const SCHEMA = TASK_RUN_SCHEMA;

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
  // Low-level persistence API. Business workflows should prefer
  // transitionExecutionState so state, events, and outbox writes stay atomic.
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
          WHEN $6::timestamptz IS NULL AND $2 IN ('succeeded', 'failed', 'cancelled', 'blocked') THEN NULL
          ELSE COALESCE($6::timestamptz, lease_expires_at)
        END,
        updated_at = now(),
        started_at = CASE
          WHEN $2 = 'running' AND started_at IS NULL THEN now()
          ELSE started_at
        END,
        completed_at = CASE
          WHEN $2 IN ('succeeded', 'failed', 'cancelled', 'blocked') THEN now()
          ELSE completed_at
        END
    WHERE id = $1
    RETURNING *
  `,
    [id, status, JSON.stringify(metadata), nodeId, heartbeatAt, leaseExpiresAt],
  );
  return rows.rows[0] ? rowToTaskRun(rows.rows[0]) : null;
}

/**
 * Update task run metadata and operational fields WITHOUT changing status.
 *
 * Use this after `transitionExecutionState()` to apply metadata updates
 * (model, maxLoops, loopCount, error, cancelReason, etc.) without risking
 * a second unvalidated status change.
 */
export async function updateTaskRunFields(
  id: string,
  updates: UpdateTaskRunFieldsInput,
): Promise<TaskRunRecord | null> {
  await ensureTaskRunStore();
  const db = getDb();
  const existing = await loadTaskRun(id);
  if (!existing) return null;

  const metadata = updates.runContract === undefined
    ? updates.metadata ?? existing.metadata
    : mergeRunContractMetadata(updates.metadata ?? existing.metadata, updates.runContract);
  const nodeId = updates.nodeId === undefined ? null : updates.nodeId;
  const heartbeatAt = updates.heartbeatAt === undefined ? null : updates.heartbeatAt;
  const leaseExpiresAt = updates.leaseExpiresAt === undefined ? null : updates.leaseExpiresAt;
  const attempt = updates.attempt;

  const rows = await db.query<TaskRunRow>(
    `
    UPDATE task_runs
    SET metadata_json = $2::jsonb,
        node_id = COALESCE($3, node_id),
        heartbeat_at = COALESCE($4::timestamptz, heartbeat_at),
        lease_expires_at = COALESCE($5::timestamptz, lease_expires_at),
        attempt = COALESCE($6, attempt),
        updated_at = now()
    WHERE id = $1
    RETURNING *
  `,
    [id, JSON.stringify(metadata), nodeId, heartbeatAt, leaseExpiresAt, attempt ?? null],
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
): Promise<TaskRunRecoveryResult> {
  await ensureTaskRunStore();
  const backend = await resolveCoordinationBackend();
  const result = await backend.lock.withLock('task-run-recovery', async () => {
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
  });
  if (result === null) {
    return { lockAcquired: false, recovered: [] };
  }
  return { lockAcquired: true, recovered: result };
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

export async function listTaskRunsByStatus(
  status: 'failed' | 'cancelled' | 'blocked',
  limit = 50,
): Promise<TaskRunRecord[]> {
  await ensureTaskRunStore();
  const db = getDb();
  const rows = await db.query<TaskRunRow>(
    'SELECT * FROM task_runs WHERE status = $1 ORDER BY completed_at DESC NULLS LAST LIMIT $2',
    [status, limit],
  );
  return rows.rows.map(rowToTaskRun);
}
