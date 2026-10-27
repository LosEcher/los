import { getDb, withDbClient } from '@los/infra/db';
import { resolveCoordinationBackend } from './coordination/resolve.js';
import { mergeRunContractMetadata, type RunContractMetadataInput } from './run-contract.js';
import { TASK_RUN_SCHEMA } from './task-runs/schema.js';
import { assertRow, normalizeLeaseMs, toIsoString } from './task-runs/normalizers.js';
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
  leaseVersion: number;
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
  leaseVersion?: number;
  leaseExpiresAt?: Date | string;
}

export interface UpdateTaskRunFieldsInput {
  provider?: string;
  model?: string;
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
      attempt, prompt_preview, metadata_json, heartbeat_at, lease_version, lease_expires_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb,
      CASE WHEN $20::timestamptz IS NULL THEN NULL ELSE now() END, $19, $20::timestamptz, now())
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
      input.leaseVersion ?? 0,
      input.leaseExpiresAt ?? null,
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
  const provider = updates.provider === undefined ? null : updates.provider, model = updates.model === undefined ? null : updates.model;

  const rows = await db.query<TaskRunRow>(
    `
    UPDATE task_runs
    SET metadata_json = $2::jsonb,
        node_id = COALESCE($3, node_id),
        heartbeat_at = COALESCE($4::timestamptz, heartbeat_at),
        lease_expires_at = COALESCE($5::timestamptz, lease_expires_at),
        attempt = COALESCE($6, attempt),
        provider = COALESCE($7, provider),
        model = COALESCE($8, model),
        updated_at = now()
    WHERE id = $1
    RETURNING *
  `,
    [id, JSON.stringify(metadata), nodeId, heartbeatAt, leaseExpiresAt, attempt ?? null, provider, model],
  );
  return rows.rows[0] ? rowToTaskRun(rows.rows[0]) : null;
}

export async function heartbeatTaskRun(
  id: string,
  input: { nodeId: string; leaseVersion: number; leaseMs?: number },
): Promise<TaskRunRecord | null> {
  await ensureTaskRunStore();
  const db = getDb();
  const leaseMs = normalizeLeaseMs(input.leaseMs);
  const rows = await db.query<TaskRunRow>(
    `
    UPDATE task_runs
    SET heartbeat_at = now(),
        lease_expires_at = now() + ($4::text || ' milliseconds')::interval,
        updated_at = now()
    WHERE id = $1
      AND status IN ('queued', 'running')
      AND node_id = $2
      AND lease_version = $3
      AND lease_expires_at > now()
    RETURNING *
  `,
    [id, input.nodeId, input.leaseVersion, leaseMs],
  );
  return rows.rows[0] ? rowToTaskRun(rows.rows[0]) : null;
}

export async function recoverExpiredTaskRuns(reason = 'lease_expired'): Promise<TaskRunRecord[]> {
  await ensureTaskRunStore();
  return recoverExpiredTaskRunsWithStateTransition(reason);
}

export async function recoverExpiredTaskRunsWithAdvisoryLock(
  reason = 'lease_expired',
): Promise<TaskRunRecoveryResult> {
  await ensureTaskRunStore();
  const backend = await resolveCoordinationBackend();
  const result = await backend.lock.withLock('task-run-recovery', async () => {
    return recoverExpiredTaskRunsWithStateTransition(reason);
  });
  if (result === null) {
    return { lockAcquired: false, recovered: [] };
  }
  return { lockAcquired: true, recovered: result };
}

async function recoverExpiredTaskRunsWithStateTransition(reason: string): Promise<TaskRunRecord[]> {
  const db = getDb();
  const rows = await db.query<TaskRunRow>(
    `SELECT * FROM task_runs
     WHERE status IN ('queued', 'running')
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at < now()
     ORDER BY updated_at ASC`,
  );
  if (rows.rows.length === 0) return [];

  const { _LeaseLostError, transitionExecutionState } = await import('./execution-store.js');
  const recovered: TaskRunRecord[] = [];
  for (const row of rows.rows) {
    const task = rowToTaskRun(row);
    try {
      await transitionExecutionState({
        entityType: 'task_run',
        entityId: task.id,
        to: 'failed',
        sessionId: task.sessionId,
        reason,
        nodeId: task.nodeId,
        attempt: task.attempt,
        leaseVersion: task.nodeId ? task.leaseVersion : undefined,
        leaseCondition: task.nodeId ? 'expired' : undefined,
      });
    } catch (error) {
      if (error instanceof _LeaseLostError) continue;
      throw error;
    }
    const updated = await updateTaskRunFields(task.id, {
      metadata: { ...task.metadata, recoveryReason: reason },
      leaseExpiresAt: null,
    });
    if (updated) recovered.push(updated);
  }
  return recovered;
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

/**
 * List task runs, newest first.
 *
 * `scope.tenantId` (optional) restricts the projection to one tenant. The HTTP
 * boundary passes it for authenticated non-operator principals
 * (`resolveReadScope` in the gateway); internal callers (scheduler, governance,
 * fleet) omit it and keep their cross-tenant view. Tenant-only on purpose: the
 * task projection is cross-project by design.
 */
/**
 * 列出 task runs；`scope.status` 走服务端过滤。
 * 为什么必须有：Web 的 Tasks 页一直在发 `/tasks?status=`，而路由过去**不读**该参数
 * ⇒ 下拉框看起来可用、实际不生效（2026-10-11 实测）。过滤在服务端做才与真源一致。
 */
export async function listTaskRuns(
  limit = 50,
  scope?: { tenantId?: string; status?: string; projectId?: string },
): Promise<TaskRunRecord[]> {
  await ensureTaskRunStore();
  const params: unknown[] = []; const where: string[] = [];
  const add = (value: unknown, sql: string) => { params.push(value); where.push(sql.replace('$', `$${params.length}`)); };
  if (scope?.tenantId) add(scope.tenantId, 'tenant_id = $');
  if (scope?.status) add(scope.status, 'status = $');
  // task_runs 自带 project_id 列（`\d task_runs` 实测）⇒ 普通列过滤，无需 join run_specs
  if (scope?.projectId) add(scope.projectId, 'project_id = $');
  params.push(limit);
  const sql = `SELECT * FROM task_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT $${params.length}`;
  const rows = await getDb().query<TaskRunRow>(sql, params);
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

export async function listActiveTaskRunsForSession(sessionId: string): Promise<TaskRunRecord[]> {
  await ensureTaskRunStore();
  const db = getDb();
  const rows = await db.query<TaskRunRow>(
    `SELECT * FROM task_runs
     WHERE session_id = $1 AND status IN ('queued', 'running')
     ORDER BY updated_at DESC`,
    [sessionId],
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

export { claimBlockedTaskRunsWithAnswer, type ClaimedBlockedTaskRun } from './task-runs/blocked-resume.js';
export { recoverActiveTaskRunsForGateway } from './task-runs/recovery.js';

/**
 * 按**落点**（`task_runs.node_id`）做有界时间窗聚合 —— 机队拓扑里"谁真的在哪台机器上跑过"的观测面。
 *
 * 为什么按观测而不是按声明：`run_specs.node_id` 结构上不可达（放置路径不建 run_spec，711/711 NULL），
 * 而"注册表里有这台机器"不等于"它真的承接了任务"。两者必须分开画，否则图会声称一种并不存在的可用性。
 *
 * 三条与"随手写个 group by"不同的地方：
 *   1. **时间窗必填**：没有窗口就是全表聚合，资源守卫不允许（类型层强制，不是文档约定）。
 *   2. `node_id` **原样返回**，不做归一化：实测这个字段里混着 `gateway-local`（网关进程内执行）、
 *      `node-2`（未登记）和一个 **URL**（URL 硬钉路径污染）。归一化是读模型的语义决定；
 *      存储层擅自合并会把"字段被当成两种东西用"这个症状抹掉。NULL 也原样保留。
 *   3. `truncated` 可观测：按 total 倒序截断时，调用方必须能看出"还有别的落点没画进来"。
 */
export interface TaskRunPlacementSummary {
  /** 原样的 `task_runs.node_id`；`null` = 该行没有落点（历史行或非派发路径）。 */
  nodeId: string | null;
  total: number;
  succeeded: number;
  failed: number;
  blocked: number;
  /** 该落点最近一次任务的时间（ISO）；无记录为 null。 */
  lastAt: string | null;
}

export interface SummarizeTaskRunPlacementOptions {
  /** 窗口下界（含）。必填。 */
  since: string | Date;
  /** 窗口上界（含）。默认 = 现在。 */
  until?: string | Date;
  /** 落点分组上限，默认 100、上限 500。 */
  limit?: number;
}

export async function summarizeTaskRunPlacement(
  options: SummarizeTaskRunPlacementOptions,
): Promise<{ rows: TaskRunPlacementSummary[]; truncated: boolean; window: { since: string; until: string } }> {
  await ensureTaskRunStore();
  const since = toIsoString(options.since);
  const until = toIsoString(options.until ?? new Date());
  const requested = Number(options.limit);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(500, Math.floor(requested))) : 100;
  // 多取一行只为判断"是否还有别的落点被截掉"，不改变返回集。
  const rows = await getDb().query<{
    node_id: string | null;
    total: number;
    succeeded: number;
    failed: number;
    blocked: number;
    last_at: Date | string | null;
  }>(
    `SELECT node_id,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
            COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked,
            MAX(created_at) AS last_at
     FROM task_runs
     WHERE created_at >= $1 AND created_at <= $2
     GROUP BY node_id
     ORDER BY total DESC, node_id ASC NULLS LAST
     LIMIT $3`,
    [since, until, limit + 1],
  );
  const truncated = rows.rows.length > limit;
  return {
    rows: rows.rows.slice(0, limit).map(row => ({
      nodeId: row.node_id,
      total: Number(row.total),
      succeeded: Number(row.succeeded),
      failed: Number(row.failed),
      blocked: Number(row.blocked),
      lastAt: row.last_at ? toIsoString(row.last_at) : null,
    })),
    truncated,
    window: { since, until },
  };
}
