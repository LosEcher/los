import { getDb } from '@los/infra/db';
import { normalizeOptionalString } from './scheduler/helpers.js';

export type SchedulerDecisionKind = 'claim' | 'provider_selection' | 'executor_selection' | 'task_outcome';

/**
 * 已知 kind 的**运行时**清单（单一真源）。
 * 为什么要有运行时值：读路径要能判断"这一行的 kind 是不是闭集之内"，
 * 而 type union 在运行时不存在。硬编码第二份清单必然漂移——
 * 实测教训：读模型里按单一 kind 比较，把合法的 `task_outcome` 报成了"非预期 kind"，
 * 于是告警通道在真实数据上永久误报（假警报会把通道训练成噪音）。
 */
const KNOWN_KINDS: readonly SchedulerDecisionKind[] = [
  'claim',
  'provider_selection',
  'executor_selection',
  'task_outcome',
];

/**
 * 判断一个原始 kind 是否落在闭集内。
 * 为什么导出**谓词**而不是导出清单常量：清单常量在别的模块里只会被成员判断消费
 * （不构成"调用"），而接线门禁的判据是"导出符号必须在别处被调用" ⇒
 * 导出清单会被机械判成孤儿导出。谓词既满足门禁，也正是消费方真正需要的能力。
 */
export function isSchedulerDecisionKind(value: unknown): value is SchedulerDecisionKind {
  return typeof value === 'string' && (KNOWN_KINDS as readonly string[]).includes(value);
}

export interface SchedulerDecisionRecord {
  id: string;
  graphId: string;
  taskId?: string;
  attemptId?: string;
  taskRunId?: string;
  runSpecId?: string;
  sessionId?: string;
  nodeId?: string;
  /**
   * 已知 kind；`null` 表示这一行是**类型外的历史值**（见 `kindRaw`）。
   *
   * 为什么读路径不抛错：库里实测存在 `kind='placement_decision'`（2026-06-21，2 行）。
   * 旧实现让读路径的 `normalizeKind` 抛错 ⇒ **任何不带 kind 过滤的批量读整段失败**，
   * 这类行于是永久不可见——错误被吞成"查不出来"，而不是"有一行不认识"。
   * 现在它是可检测状态：调用方可以计数/告警/按需忽略（"错误即数据"）。
   * 写路径仍然严格（`normalizeKind`），不接受类型外的值写入。
   */
  kind: SchedulerDecisionKind | null;
  /** 数据库里的原始 kind 文本，永远保留（可追溯：图上/报告里能显示它到底是什么）。 */
  kindRaw: string;
  selectedIds: string[];
  skipped: Array<{ id: string; reason: string; details?: Record<string, unknown> }>;
  reason: string;
  provider?: string;
  model?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RecordSchedulerDecisionInput {
  id?: string;
  graphId: string;
  taskId?: string;
  attemptId?: string;
  taskRunId?: string;
  runSpecId?: string;
  sessionId?: string;
  nodeId?: string;
  kind: SchedulerDecisionKind;
  selectedIds?: readonly string[];
  skipped?: readonly { id: string; reason: string; details?: Record<string, unknown> }[];
  reason: string;
  provider?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface ListSchedulerDecisionsOptions {
  graphId?: string;
  taskId?: string;
  kind?: SchedulerDecisionKind;
  limit?: number;
}


const SCHEMA = `
CREATE TABLE IF NOT EXISTS scheduler_decisions (
  id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL,
  task_id TEXT,
  attempt_id TEXT,
  task_run_id TEXT,
  run_spec_id TEXT,
  session_id TEXT,
  node_id TEXT,
  kind TEXT NOT NULL,
  selected_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  skipped_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_graph ON scheduler_decisions(graph_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_task ON scheduler_decisions(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_kind ON scheduler_decisions(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_session ON scheduler_decisions(session_id, created_at DESC);
-- 时间窗倒序读（listSchedulerDecisionWindow）只按 created_at 过滤：上面四个复合索引都以
-- 别的列打头，用不上它 ⇒ 没有这个索引时窗口查询退化成全表扫（现在表小，随决策增长会变成热点）。
CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_created ON scheduler_decisions(created_at DESC);
`;

let _initialized = false;

export async function ensureSchedulerDecisionLedgerStore(): Promise<void> {
  if (_initialized) return;
  await getDb().exec(SCHEMA);
  _initialized = true;
}

export async function recordSchedulerDecision(input: RecordSchedulerDecisionInput): Promise<SchedulerDecisionRecord> {
  await ensureSchedulerDecisionLedgerStore();
  const graphId = normalizeRequiredString(input.graphId, 'graphId');
  const kind = normalizeKind(input.kind);
  const reason = normalizeRequiredString(input.reason, 'reason');
  const id = normalizeOptionalString(input.id)
    ?? `scheduler-decision-${graphId}-${kind}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const rows = await getDb().query<SchedulerDecisionRow>(
    `
    INSERT INTO scheduler_decisions (
      id, graph_id, task_id, attempt_id, task_run_id, run_spec_id, session_id,
      node_id, kind, selected_ids_json, skipped_json, reason, provider, model, metadata_json
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15::jsonb)
    ON CONFLICT (id) DO UPDATE SET
      graph_id = EXCLUDED.graph_id,
      task_id = EXCLUDED.task_id,
      attempt_id = EXCLUDED.attempt_id,
      task_run_id = EXCLUDED.task_run_id,
      run_spec_id = EXCLUDED.run_spec_id,
      session_id = EXCLUDED.session_id,
      node_id = EXCLUDED.node_id,
      kind = EXCLUDED.kind,
      selected_ids_json = EXCLUDED.selected_ids_json,
      skipped_json = EXCLUDED.skipped_json,
      reason = EXCLUDED.reason,
      provider = EXCLUDED.provider,
      model = EXCLUDED.model,
      metadata_json = EXCLUDED.metadata_json
    RETURNING *
  `,
    [
      id,
      graphId,
      normalizeOptionalString(input.taskId) ?? null,
      normalizeOptionalString(input.attemptId) ?? null,
      normalizeOptionalString(input.taskRunId) ?? null,
      normalizeOptionalString(input.runSpecId) ?? null,
      normalizeOptionalString(input.sessionId) ?? null,
      normalizeOptionalString(input.nodeId) ?? null,
      kind,
      JSON.stringify(uniqueStrings(input.selectedIds ?? [])),
      JSON.stringify(normalizeSkipped(input.skipped ?? [])),
      reason,
      normalizeOptionalString(input.provider) ?? null,
      normalizeOptionalString(input.model) ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return rowToRecord(assertRow(rows.rows[0]));
}

export async function listSchedulerDecisions(
  options: ListSchedulerDecisionsOptions = {},
): Promise<SchedulerDecisionRecord[]> {
  await ensureSchedulerDecisionLedgerStore();
  const clauses: string[] = [];
  const params: unknown[] = [];
  const graphId = normalizeOptionalString(options.graphId);
  const taskId = normalizeOptionalString(options.taskId);
  const kind = options.kind ? normalizeKind(options.kind) : undefined;
  if (graphId) {
    params.push(graphId);
    clauses.push(`graph_id = $${params.length}`);
  }
  if (taskId) {
    params.push(taskId);
    clauses.push(`task_id = $${params.length}`);
  }
  if (kind) {
    params.push(kind);
    clauses.push(`kind = $${params.length}`);
  }
  const limit = normalizeLimit(options.limit, 100);
  params.push(limit);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await getDb().query<SchedulerDecisionRow>(
    `
    SELECT *
    FROM scheduler_decisions
    ${where}
    ORDER BY created_at ASC, id ASC
    LIMIT $${params.length}
  `,
    params,
  );
  return rows.rows.map(rowToRecord);
}

export interface TaskOutcomeInput {
  taskRunId: string;
  runSpecId?: string;
  sessionId?: string;
  provider: string;
  model: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  durationMs: number;
  totalTokens?: number;
  loopCount?: number;
  error?: string;
}

/**
 * Record a task completion outcome for scheduler feedback.
 *
 * This closes the decision loop: the scheduler can query recent outcomes per
 * provider/model to inform future selection decisions (e.g. deprioritize a
 * provider with recent failures, prefer one with low latency).
 */
export async function recordTaskOutcome(input: TaskOutcomeInput): Promise<SchedulerDecisionRecord> {
  return recordSchedulerDecision({
    graphId: input.taskRunId,
    taskRunId: input.taskRunId,
    runSpecId: input.runSpecId,
    sessionId: input.sessionId,
    kind: 'task_outcome',
    provider: input.provider,
    model: input.model,
    reason: input.status,
    selectedIds: [`${input.provider}:${input.model}`],
    metadata: {
      durationMs: input.durationMs,
      totalTokens: input.totalTokens ?? 0,
      loopCount: input.loopCount ?? 0,
      error: input.error ?? null,
    },
  });
}

export interface ProviderRecentOutcome {
  provider: string;
  model: string;
  totalTasks: number;
  succeeded: number;
  failed: number;
  avgDurationMs: number;
  avgTokens: number;
  lastOutcomeAt: string;
}

/**
 * Query recent task outcomes for a provider/model combo.
 * Used by the scheduler to inform provider selection: recent failures
 * or high latency can trigger fallback routing.
 *
 * @param provider - Provider name
 * @param model - Model name (optional)
 * @param windowHours - Lookback window in hours (default 24)
 * @param limit - Max outcomes to aggregate (default 50)
 */
export async function getProviderRecentOutcomes(
  provider: string,
  model?: string,
  windowHours = 24,
  limit = 50,
): Promise<ProviderRecentOutcome[]> {
  await ensureSchedulerDecisionLedgerStore();
  const params: unknown[] = [provider, windowHours];
  let modelClause = '';
  if (model) {
    params.push(model);
    modelClause = `AND model = $${params.length}`;
  }
  params.push(limit);

  const rows = await getDb().query<{
    provider: string;
    model: string;
    total: string;
    succeeded: string;
    failed: string;
    avg_duration: string;
    avg_tokens: string;
    last_at: string;
  }>(
    `
    SELECT
      provider,
      model,
      COUNT(*)::text AS total,
      COUNT(*) FILTER (WHERE reason = 'succeeded')::text AS succeeded,
      COUNT(*) FILTER (WHERE reason = 'failed')::text AS failed,
      COALESCE(AVG((metadata_json->>'durationMs')::numeric), 0)::text AS avg_duration,
      COALESCE(AVG((metadata_json->>'totalTokens')::numeric), 0)::text AS avg_tokens,
      MAX(created_at)::text AS last_at
    FROM scheduler_decisions
    WHERE kind = 'task_outcome'
      AND provider = $1
      AND created_at > now() - ($2 || ' hours')::interval
      ${modelClause}
    GROUP BY provider, model
    ORDER BY last_at DESC
    LIMIT $${params.length}
  `,
    params,
  );

  return rows.rows.map(r => ({
    provider: r.provider,
    model: r.model,
    totalTasks: Number(r.total),
    succeeded: Number(r.succeeded),
    failed: Number(r.failed),
    avgDurationMs: Math.round(Number(r.avg_duration)),
    avgTokens: Math.round(Number(r.avg_tokens)),
    lastOutcomeAt: r.last_at,
  }));
}

export type SchedulerDecisionRow = {
  id: string;
  graph_id: string;
  task_id: string | null;
  attempt_id: string | null;
  task_run_id: string | null;
  run_spec_id: string | null;
  session_id: string | null;
  node_id: string | null;
  kind: string;
  selected_ids_json: unknown;
  skipped_json: unknown;
  reason: string;
  provider: string | null;
  model: string | null;
  metadata_json: unknown;
  created_at: Date | string;
};

export function rowToRecord(row: SchedulerDecisionRow): SchedulerDecisionRecord {
  return {
    id: row.id,
    graphId: row.graph_id,
    taskId: row.task_id ?? undefined,
    attemptId: row.attempt_id ?? undefined,
    taskRunId: row.task_run_id ?? undefined,
    runSpecId: row.run_spec_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    nodeId: row.node_id ?? undefined,
    kind: readKind(row.kind),
    kindRaw: row.kind,
    selectedIds: normalizeStringArray(row.selected_ids_json),
    skipped: normalizeSkippedFromJson(row.skipped_json),
    reason: row.reason,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    metadata: normalizeJsonObject(row.metadata_json),
    createdAt: toIsoString(row.created_at),
  };
}



/**
 * 写路径：类型外的值一律拒绝（fail closed，守卫只能收紧）。
 */
function normalizeKind(value: unknown): SchedulerDecisionKind {
  if (isSchedulerDecisionKind(value)) return value;
  throw new Error('scheduler decision kind is invalid');
}

/**
 * 读路径：类型外 = `null`（可检测状态），不抛错。原值由 `kindRaw` 保留。
 * 读路径与写路径**必须分开**：写路径拒绝坏数据，读路径不能因为一行历史坏数据就整段查不出来。
 */
function readKind(value: unknown): SchedulerDecisionKind | null {
  return isSchedulerDecisionKind(value) ? value : null;
}

function normalizeSkipped(
  skipped: readonly { id: string; reason: string; details?: Record<string, unknown> }[],
): Array<{ id: string; reason: string; details?: Record<string, unknown> }> {
  return skipped.flatMap((item) => {
    const id = normalizeOptionalString(item.id);
    const reason = normalizeOptionalString(item.reason);
    if (!id || !reason) return [];
    return [{ id, reason, details: normalizeJsonObject(item.details ?? {}) }];
  });
}

function normalizeSkippedFromJson(value: unknown): Array<{ id: string; reason: string; details?: Record<string, unknown> }> {
  if (!Array.isArray(value)) {
    if (typeof value !== 'string') return [];
    try {
      return normalizeSkippedFromJson(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return normalizeSkipped(value as Array<{ id: string; reason: string; details?: Record<string, unknown> }>);
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return uniqueStrings(value.map(item => String(item)));
  if (typeof value !== 'string') return [];
  try {
    return normalizeStringArray(JSON.parse(value));
  } catch {
    return [];
  }
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      return normalizeJsonObject(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return {};
}

function normalizeRequiredString(value: unknown, name: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function normalizeLimit(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(500, Math.floor(value)));
}

function uniqueStrings(value: readonly string[]): string[] {
  return [...new Set(value.map(item => item.trim()).filter(Boolean))];
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('scheduler decision row not returned');
  return row;
}
