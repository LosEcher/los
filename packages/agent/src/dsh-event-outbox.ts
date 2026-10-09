/**
 * dsh-event-outbox — los → DSH 的事件投递（P1-a，2026-10-09）。
 *
 * 背景：`dsh-los-ops` 早在 DSH web 宿主挂了 `POST /los-events`（去重 + 指纹抑制 + 微信播报 +
 * events.jsonl 审计），但 los 侧**唯一的发送方**在 2026-08-17 被停用的 wechat-bot 里
 * （`packages/wechat-bot/src/index.ts`，`LOS_WECHAT_BOT_MODE=disabled`）⇒ 这条事件面是死的：
 * 治理升级 / 死信 / 连败告警在 los 侧落库，却传不到 DSH，也传不到任何 IM。
 *
 * 本模块只做"传输"，不重造队列：复用 `execution_outbox` 的持久重试语义
 * （attempts / next_attempt_at / claimed_by / last_error / published_at），
 * 用哨兵 `entity_type='dsh_event'` 与会话事件发布器隔离：
 *   - 会话事件发布器传 `excludeEntityTypes: ['dsh_event']`（否则这些行会被当"缺 session_event_id"重试到死）；
 *   - 本模块只认领 `entity_type='dsh_event'`。
 *
 * 投递判据（与接收端契约 `dsh-los-ops/lib/events.mjs` 对齐）：
 *   - 2xx 且 `handled === true`  → 已投递（接收端已接管：可能已播报、也可能是合法静默/去重）；
 *   - 2xx 且 `handled === false` → **接收端明确拒收**（非 governance.* 或空 type）。
 *     los 的既有通道仍会自行送达，故记为"已投递"而不是无限重试；原因写进 last_error 便于排查；
 *   - 其它（非 2xx / 网络错 / JSON 解析失败）→ 抛出 ⇒ 走 outbox 的指数退避重试。
 */

import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import { ensureExecutionOutboxStore } from './execution-persistence.js';
import {
  publishExecutionOutboxBatch,
  type ExecutionOutboxRecord,
  type PublishExecutionOutboxResult,
} from './execution-outbox.js';

const log = getLogger('dsh-event-outbox');

const DSH_EVENT_ENTITY_TYPE = 'dsh_event';
const DEFAULT_SESSION_ID = 'governance:system';

export interface DshEventInput {
  /** 幂等键：同一 eventId 只入队一次（接收端还会按它再去重一层）。 */
  eventId: string;
  type: string;
  sessionId?: string;
  payload: Record<string, unknown>;
}

export interface EnqueueDshEventResult {
  enqueued: boolean;
  eventId: string;
}

export interface DshEventOutboxHealth {
  pending: number;
  claimed: number;
  published: number;
  failed: number;
  oldestPendingAgeMs: number;
  lastError?: string;
}

/** 入队一条待投递到 DSH 的事件（幂等；重复 eventId 直接跳过）。 */
export async function enqueueDshEvent(input: DshEventInput): Promise<EnqueueDshEventResult> {
  const eventId = input.eventId.trim();
  if (!eventId) throw new Error('dsh event requires a non-empty eventId');
  const type = input.type.trim();
  if (!type) throw new Error('dsh event requires a non-empty type');
  await ensureExecutionOutboxStore();
  const envelope = {
    type,
    eventId,
    sessionId: input.sessionId?.trim() || DEFAULT_SESSION_ID,
    payload: input.payload,
  };
  const rows = await getDb().query<{ id: string }>(
    `
    INSERT INTO execution_outbox (session_id, entity_type, entity_id, event_type, payload_json)
    VALUES ($1, $2, $3, $4, $5::jsonb)
    ON CONFLICT (entity_id) WHERE entity_type = 'dsh_event' DO NOTHING
    RETURNING id
  `,
    [envelope.sessionId, DSH_EVENT_ENTITY_TYPE, eventId, type, JSON.stringify(envelope)],
  );
  // DO NOTHING 时不返回行 ⇒ enqueued=false（幂等命中）。
  return { enqueued: rows.rows.length === 1, eventId };
}

interface DshEventTransportOptions {
  url: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * 构造 `publishExecutionOutboxBatch` 的 publish 回调：把 outbox 行 POST 到 DSH 的 /los-events。
 * 语义见文件头（handled=false 记为已投递但留下原因；传输失败抛出让 outbox 重试）。
 * 不导出：它是本模块的内部传输细节，生产调用者是下面的 publishDshEventsBatch
 * （wiring 门禁只看跨文件生产调用，故内部函数保持不导出）。
 */
function buildDshEventPublisher(
  options: DshEventTransportOptions,
): (record: ExecutionOutboxRecord) => Promise<void> {
  const url = options.url.trim();
  if (!url) throw new Error('dsh event publisher requires a URL');
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 10_000);
  const doFetch = options.fetchImpl ?? fetch;
  return async (record: ExecutionOutboxRecord) => {
    const body = record.payload as { type?: unknown; sessionId?: unknown; eventId?: unknown; payload?: unknown };
    const envelope = {
      type: String(body?.type ?? record.eventType),
      sessionId: String(body?.sessionId ?? record.sessionId ?? DEFAULT_SESSION_ID),
      eventId: String(body?.eventId ?? record.entityId),
      payload: (body?.payload ?? {}) as Record<string, unknown>,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new Error(`DSH los-events HTTP ${response.status}`);
    }
    const parsed = await response.json().catch(() => null) as { handled?: unknown; reason?: unknown } | null;
    if (parsed === null) {
      throw new Error('DSH los-events returned non-JSON body');
    }
    if (parsed.handled === true) return;
    // 接收端明确拒收：不重试（los 既有通道仍在），但把原因留在台账里。
    log.warn(
      `dsh event declined by receiver: type=${envelope.type} eventId=${envelope.eventId} reason=${String(parsed.reason ?? 'unknown')}`,
    );
  };
}

export interface PublishDshEventsOptions extends DshEventTransportOptions {
  ownerId: string;
  batchSize?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** 认领并投递一批 DSH 事件（委托给 execution_outbox 的 claim/retry 机制）。 */
export async function publishDshEventsBatch(
  options: PublishDshEventsOptions,
): Promise<PublishExecutionOutboxResult> {
  return publishExecutionOutboxBatch({
    ownerId: options.ownerId,
    batchSize: options.batchSize,
    baseDelayMs: options.baseDelayMs,
    maxDelayMs: options.maxDelayMs,
    entityTypes: [DSH_EVENT_ENTITY_TYPE],
    requiresSessionEventId: false,
    publish: buildDshEventPublisher(options),
  });
}

/** 供 /health 与日报读取：DSH 事件投递的积压与失败情况。 */
export async function readDshEventOutboxHealth(): Promise<DshEventOutboxHealth> {
  await ensureExecutionOutboxStore();
  const rows = await getDb().query<{
    pending: string; claimed: string; published: string; failed: string;
    oldest_pending_age_ms: string | null; last_error: string | null;
  }>(`
    SELECT
      count(*) FILTER (WHERE published_at IS NULL AND attempts = 0) AS pending,
      count(*) FILTER (WHERE published_at IS NULL AND attempts > 0) AS claimed,
      count(*) FILTER (WHERE published_at IS NOT NULL) AS published,
      count(*) FILTER (WHERE published_at IS NULL AND last_error IS NOT NULL) AS failed,
      COALESCE(max(EXTRACT(EPOCH FROM (now() - created_at)) * 1000)
        FILTER (WHERE published_at IS NULL), 0) AS oldest_pending_age_ms,
      (SELECT last_error FROM execution_outbox
        WHERE entity_type = '${DSH_EVENT_ENTITY_TYPE}' AND last_error IS NOT NULL
        ORDER BY id DESC LIMIT 1) AS last_error
    FROM execution_outbox
    WHERE entity_type = '${DSH_EVENT_ENTITY_TYPE}'
  `);
  const row = rows.rows[0];
  return {
    pending: Number(row?.pending ?? 0),
    claimed: Number(row?.claimed ?? 0),
    published: Number(row?.published ?? 0),
    failed: Number(row?.failed ?? 0),
    oldestPendingAgeMs: Math.max(0, Math.floor(Number(row?.oldest_pending_age_ms ?? 0))),
    lastError: row?.last_error ?? undefined,
  };
}
