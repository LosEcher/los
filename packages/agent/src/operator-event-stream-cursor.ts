/**
 * Durable resume cursor for **external consumers of the operator event stream**.
 *
 * Why this exists (ADR 0048 / audit migration item D11): the stream endpoint
 * (`GET /operator/events/live`) defaults to `since=0` when no cursor is supplied —
 * i.e. it **replays all history**. A channel consumer that connected with no cursor
 * therefore replayed the entire operator history on every reconnect and every
 * restart: duplicate notifications, growing without bound as the ledger grows.
 *
 * The fix is a durable, consumer-keyed cursor plus a *bounded* catch-up policy:
 *   - no cursor, or a cursor older than `maxCatchupMs` ⇒ `tail=1` (skip the backlog);
 *   - otherwise ⇒ `since=<lastEventId>` (resume exactly where the consumer stopped).
 *
 * The server's replay query is exclusive (`WHERE id > $1`), so storing the last id
 * actually seen and resuming from it is neither lossy nor duplicating.
 *
 * **Not the same cursor as `operator-control-consumer.ts`.** That one is
 * session/turn-scoped delivery state for injecting steering/followup into a running
 * agent (it *claims* each event and persists its cursors in the run state). This one
 * is a whole-stream position for a consumer that only observes and notifies. Keep
 * them separate: merging them would make a notification consumer's position
 * influence what a running agent is allowed to consume.
 */
import { getDb } from '@los/infra/db';

export interface OperatorEventStreamCursor {
  lastEventId: number;
  /** Epoch ms of the last recorded event, or null when nothing was recorded. */
  updatedAtMs: number | null;
}

export interface OperatorEventStreamResume {
  /** Query string for the stream URL (`tail=1` or `since=<id>`). */
  query: string;
  mode: 'tail' | 'since';
  reason: string;
}

/** Default backlog tolerance: a short restart resumes, a long outage does not replay. */
const DEFAULT_MAX_CATCHUP_MS = 15 * 60_000;

/**
 * Pure resume policy. Kept free of IO so the boundary cases are directly testable.
 */
export function decideOperatorEventStreamResume(input: {
  lastEventId: number;
  updatedAtMs: number | null;
  nowMs: number;
  maxCatchupMs?: number;
}): OperatorEventStreamResume {
  const maxCatchupMs = input.maxCatchupMs ?? DEFAULT_MAX_CATCHUP_MS;
  const { lastEventId, updatedAtMs, nowMs } = input;
  if (!Number.isFinite(lastEventId) || lastEventId <= 0) {
    return { query: 'tail=1', mode: 'tail', reason: 'no stored cursor' };
  }
  if (updatedAtMs === null || !Number.isFinite(updatedAtMs)) {
    return { query: 'tail=1', mode: 'tail', reason: 'stored cursor has no timestamp' };
  }
  const ageMs = nowMs - updatedAtMs;
  if (ageMs > maxCatchupMs) {
    return {
      query: 'tail=1',
      mode: 'tail',
      reason:
        `cursor is ${Math.round(ageMs / 1000)}s old ` +
        `(> ${Math.round(maxCatchupMs / 1000)}s): skipping the backlog`,
    };
  }
  return { query: `since=${lastEventId}`, mode: 'since', reason: 'resuming from stored cursor' };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS operator_event_stream_cursor (
  consumer TEXT PRIMARY KEY,
  last_event_id BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let _initialized = false;

export async function ensureOperatorEventStreamCursorStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(SCHEMA);
  _initialized = true;
}

export async function loadOperatorEventStreamCursor(
  consumer: string,
): Promise<OperatorEventStreamCursor | null> {
  await ensureOperatorEventStreamCursorStore();
  const db = getDb();
  const rows = await db.query<{ last_event_id: string | number; updated_at: Date | string }>(
    'SELECT last_event_id, updated_at FROM operator_event_stream_cursor WHERE consumer = $1',
    [consumer],
  );
  const row = rows.rows[0];
  if (!row) return null;
  const updatedAt = row.updated_at instanceof Date ? row.updated_at : new Date(String(row.updated_at));
  return {
    lastEventId: Number(row.last_event_id),
    updatedAtMs: Number.isFinite(updatedAt.getTime()) ? updatedAt.getTime() : null,
  };
}

/**
 * Monotonic on write: a late flush from an older stream must not move the cursor
 * backwards. Non-finite and non-positive ids are ignored rather than stored.
 */
export async function saveOperatorEventStreamCursor(
  consumer: string,
  lastEventId: number,
): Promise<void> {
  if (!Number.isFinite(lastEventId) || lastEventId <= 0) return;
  await ensureOperatorEventStreamCursorStore();
  const db = getDb();
  await db.query(
    `
    INSERT INTO operator_event_stream_cursor (consumer, last_event_id, updated_at)
    VALUES ($1, $2, now())
    ON CONFLICT (consumer) DO UPDATE
      SET last_event_id = GREATEST(operator_event_stream_cursor.last_event_id, EXCLUDED.last_event_id),
          updated_at = now()
    `,
    [consumer, Math.floor(lastEventId)],
  );
}
