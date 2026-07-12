import { createHmac, randomUUID } from 'node:crypto';
import { getDb, withDbClient } from '@los/infra/db';
import { ensureFeedAnalysisStore } from './feed-analysis-store.js';

export interface FeedAnalysisCallbackProfile {
  url: string;
  secret: string;
  timeoutMs: number;
  maxAttempts: number;
}

export interface FeedAnalysisCallbackDeliveryResult {
  claimed: number;
  delivered: number;
  retried: number;
  deadLettered: number;
}

export interface FeedAnalysisDeadLetterDelivery {
  id: string;
  eventId: string;
  profileId: string;
  attemptCount: number;
  lastHttpStatus?: number;
  lastError?: string;
  deadLetteredAt: string;
}

interface ClaimedDelivery {
  id: string;
  eventId: string;
  profileId: string;
  attemptCount: number;
  payload: Record<string, unknown>;
}

export async function processDueFeedAnalysisCallbacks(
  profiles: Record<string, FeedAnalysisCallbackProfile>,
  options: { ownerId?: string; limit?: number; leaseMs?: number } = {},
): Promise<FeedAnalysisCallbackDeliveryResult> {
  await ensureFeedAnalysisStore();
  const ownerId = options.ownerId ?? `feed-analysis-callback-${randomUUID()}`;
  const deliveries = await claimDeliveries(ownerId, options.limit ?? 20, options.leaseMs ?? 30_000);
  const result: FeedAnalysisCallbackDeliveryResult = {
    claimed: deliveries.length,
    delivered: 0,
    retried: 0,
    deadLettered: 0,
  };
  for (const delivery of deliveries) {
    const profile = profiles[delivery.profileId];
    if (!profile) {
      await markDeadLetter(delivery.id, ownerId, 'callback profile is not configured');
      result.deadLettered += 1;
      continue;
    }
    const outcome = await deliverCallback(delivery, profile);
    if (outcome.ok) {
      await markDelivered(delivery.id, ownerId, outcome.httpStatus);
      result.delivered += 1;
      continue;
    }
    if (delivery.attemptCount >= profile.maxAttempts) {
      await markDeadLetter(delivery.id, ownerId, outcome.error, outcome.httpStatus);
      result.deadLettered += 1;
    } else {
      await markRetry(delivery.id, ownerId, outcome.error, outcome.httpStatus, outcome.retryAfterMs, delivery.attemptCount);
      result.retried += 1;
    }
  }
  return result;
}

export async function listFeedAnalysisDeadLetters(limit = 50): Promise<FeedAnalysisDeadLetterDelivery[]> {
  await ensureFeedAnalysisStore();
  const rows = await getDb().query<DeadLetterRow>(`
    SELECT id, event_id, profile_id, attempt_count, last_http_status, last_error, dead_lettered_at
    FROM feed_analysis_callback_deliveries
    WHERE status='dead_letter'
    ORDER BY dead_lettered_at DESC
    LIMIT $1
  `, [Math.max(1, Math.min(200, Math.floor(limit)))]);
  return rows.rows.map(row => ({
    id: row.id,
    eventId: row.event_id,
    profileId: row.profile_id,
    attemptCount: row.attempt_count,
    lastHttpStatus: row.last_http_status ?? undefined,
    lastError: row.last_error ?? undefined,
    deadLetteredAt: toIso(row.dead_lettered_at),
  }));
}

export async function replayFeedAnalysisDeadLetter(id: string): Promise<boolean> {
  await ensureFeedAnalysisStore();
  const result = await getDb().query<{ id: string }>(`
    UPDATE feed_analysis_callback_deliveries
    SET status='pending', attempt_count=0, next_attempt_at=now(), lease_owner=NULL,
      lease_expires_at=NULL, last_http_status=NULL, last_error=NULL, dead_lettered_at=NULL, updated_at=now()
    WHERE id=$1 AND status='dead_letter'
    RETURNING id
  `, [id]);
  return Boolean(result.rows[0]);
}

async function claimDeliveries(ownerId: string, limit: number, leaseMs: number): Promise<ClaimedDelivery[]> {
  return await withDbClient(async client => {
    await client.query('BEGIN');
    try {
      const selected = await client.query<CallbackDeliveryRow>(`
        SELECT d.id, d.event_id, d.profile_id, d.attempt_count, e.payload_json
        FROM feed_analysis_callback_deliveries d
        JOIN feed_analysis_callback_events e ON e.event_id=d.event_id
        WHERE (
          d.status='pending' AND d.next_attempt_at <= now()
        ) OR (
          d.status='delivering' AND d.lease_expires_at < now()
        )
        ORDER BY d.next_attempt_at, d.created_at
        LIMIT $1
        FOR UPDATE OF d SKIP LOCKED
      `, [Math.max(1, Math.min(100, limit))]);
      const claimed: ClaimedDelivery[] = [];
      for (const row of selected.rows) {
        const updated = await client.query<{ attempt_count: number }>(`
          UPDATE feed_analysis_callback_deliveries
          SET status='delivering', attempt_count=attempt_count+1, lease_owner=$2,
            lease_expires_at=now()+($3::text || ' milliseconds')::interval, updated_at=now()
          WHERE id=$1 RETURNING attempt_count
        `, [row.id, ownerId, leaseMs]);
        claimed.push({
          id: row.id,
          eventId: row.event_id,
          profileId: row.profile_id,
          attemptCount: updated.rows[0]?.attempt_count ?? row.attempt_count + 1,
          payload: readObject(row.payload_json),
        });
      }
      await client.query('COMMIT');
      return claimed;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

async function deliverCallback(
  delivery: ClaimedDelivery,
  profile: FeedAnalysisCallbackProfile,
): Promise<{ ok: true; httpStatus: number } | { ok: false; error: string; httpStatus?: number; retryAfterMs?: number }> {
  let url: URL;
  try {
    url = validateCallbackUrl(profile.url);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const rawBody = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', profile.secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), profile.timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-los-event-id': delivery.eventId,
        'x-los-event-sequence': String(delivery.payload.sequence ?? ''),
        'x-los-timestamp': timestamp,
        'x-los-signature': `v1=${signature}`,
      },
      body: rawBody,
    });
    if (response.ok) return { ok: true, httpStatus: response.status };
    return {
      ok: false,
      error: `callback returned HTTP ${response.status}`,
      httpStatus: response.status,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
    };
  } catch (error) {
    return { ok: false, error: `callback request failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timeout);
  }
}

async function markDelivered(id: string, ownerId: string, httpStatus: number): Promise<void> {
  await getDb().query(`
    UPDATE feed_analysis_callback_deliveries
    SET status='delivered', last_http_status=$3, last_error=NULL, delivered_at=now(),
      lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
    WHERE id=$1 AND lease_owner=$2
  `, [id, ownerId, httpStatus]);
}

async function markRetry(
  id: string,
  ownerId: string,
  error: string,
  httpStatus: number | undefined,
  retryAfterMs: number | undefined,
  attemptCount: number,
): Promise<void> {
  const delayMs = retryAfterMs ?? Math.min(300_000, 1000 * 2 ** Math.min(8, attemptCount - 1));
  const jitteredMs = Math.floor(delayMs * (0.8 + Math.random() * 0.4));
  await getDb().query(`
    UPDATE feed_analysis_callback_deliveries
    SET status='pending', next_attempt_at=now()+($3::text || ' milliseconds')::interval,
      last_http_status=$4, last_error=$5, lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
    WHERE id=$1 AND lease_owner=$2
  `, [id, ownerId, jitteredMs, httpStatus ?? null, error.slice(0, 2000)]);
}

async function markDeadLetter(
  id: string,
  ownerId: string,
  error: string,
  httpStatus?: number,
): Promise<void> {
  await getDb().query(`
    UPDATE feed_analysis_callback_deliveries
    SET status='dead_letter', last_http_status=$3, last_error=$4, dead_lettered_at=now(),
      lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
    WHERE id=$1 AND lease_owner=$2
  `, [id, ownerId, httpStatus ?? null, error.slice(0, 2000)]);
}

function validateCallbackUrl(value: string): URL {
  const url = new URL(value);
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username || url.password) {
    throw new Error('callback URL must be HTTPS, except loopback HTTP, and contain no credentials');
  }
  return url;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(300_000, seconds * 1000);
  const date = new Date(value).getTime();
  return Number.isFinite(date) ? Math.max(0, Math.min(300_000, date - Date.now())) : undefined;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

type CallbackDeliveryRow = {
  id: string;
  event_id: string;
  profile_id: string;
  attempt_count: number;
  payload_json: unknown;
};

type DeadLetterRow = {
  id: string;
  event_id: string;
  profile_id: string;
  attempt_count: number;
  last_http_status: number | null;
  last_error: string | null;
  dead_lettered_at: Date | string;
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
