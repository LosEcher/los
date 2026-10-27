/**
 * WeChat channel adapter for the shared operator-event stream cursor.
 *
 * The resume policy and the durable store live in
 * `@los/agent/operator-event-stream-cursor` (single source, audit item D11). This
 * module only supplies what is channel-specific: the consumer identity, the env
 * knobs, and the write throttle. It exists as its own file because
 * `wechat-bot/src/index.ts` is at the 700-line structure limit.
 */
import {
  decideOperatorEventStreamResume,
  loadOperatorEventStreamCursor,
  saveOperatorEventStreamCursor,
  type OperatorEventStreamResume,
} from '@los/agent/operator-event-stream-cursor';

/** Durable cursor identity for this channel consumer. */
export const WECHAT_STREAM_CONSUMER = 'wechat';

/** Bounded catch-up: a cursor older than this skips the backlog instead of replaying it. */
export const SSE_MAX_CATCHUP_MS = Number(process.env.SSE_MAX_CATCHUP_MS ?? 15 * 60_000);

/** How often the durable cursor is flushed while the stream is live. */
export const SSE_CURSOR_FLUSH_MS = Number(process.env.SSE_CURSOR_FLUSH_MS ?? 5_000);

let lastCursorFlushMs = 0;

/**
 * Decide how to resume the stream. The in-memory position wins while it is ahead of
 * the stored one: it is always fresher than the last flushed row, so an
 * intra-process reconnect still resumes immediately.
 */
export async function resumeWechatStreamCursor(
  inMemoryLastEventId: number,
): Promise<OperatorEventStreamResume> {
  const stored = await loadOperatorEventStreamCursor(WECHAT_STREAM_CONSUMER).catch(err => {
    console.error(`[events] cursor load failed (falling back to tail): ${err?.message ?? err}`);
    return null;
  });
  const useInMemory = inMemoryLastEventId > 0 && inMemoryLastEventId >= (stored?.lastEventId ?? 0);
  const nowMs = Date.now();
  return decideOperatorEventStreamResume({
    lastEventId: useInMemory ? inMemoryLastEventId : (stored?.lastEventId ?? 0),
    updatedAtMs: useInMemory ? nowMs : (stored?.updatedAtMs ?? null),
    nowMs,
    maxCatchupMs: SSE_MAX_CATCHUP_MS,
  });
}

/** Persist the durable cursor (best effort; never throws into the stream loop). */
export async function flushWechatStreamCursor(lastEventId: number): Promise<void> {
  if (lastEventId <= 0) return;
  lastCursorFlushMs = Date.now();
  await saveOperatorEventStreamCursor(WECHAT_STREAM_CONSUMER, lastEventId).catch(err => {
    console.error(`[events] cursor save failed (will retry on the next flush): ${err?.message ?? err}`);
  });
}

/** Persist only if the throttle window has elapsed. */
export async function flushWechatStreamCursorIfDue(lastEventId: number): Promise<void> {
  if (Date.now() - lastCursorFlushMs < SSE_CURSOR_FLUSH_MS) return;
  await flushWechatStreamCursor(lastEventId);
}
