import { getDb, withDbClient } from '@los/infra/db';
import { ensureExecutionOutboxStore } from './execution-persistence.js';

export interface ExecutionOutboxRecord {
  id: number;
  sessionId: string;
  runSpecId?: string;
  entityType: string;
  entityId: string;
  eventType: string;
  sessionEventId?: number;
  payload: Record<string, unknown>;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
  claimedBy?: string;
  claimedAt?: string;
  publishedAt?: string;
  createdAt: string;
}

export interface ExecutionOutboxHealth {
  pendingCount: number;
  claimedCount: number;
  legacyCount: number;
  oldestPendingAt?: string;
  oldestPendingAgeMs: number;
  legacyThroughId?: number;
}

export interface PublishExecutionOutboxResult {
  claimed: number;
  published: number;
  retried: number;
}

export interface PublishExecutionOutboxOptions {
  ownerId: string;
  batchSize?: number;
  claimMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  publish?: (record: ExecutionOutboxRecord) => Promise<void>;
}

type ExecutionOutboxRow = {
  id: string | number;
  session_id: string;
  run_spec_id: string | null;
  entity_type: string;
  entity_id: string;
  event_type: string;
  session_event_id: string | number | null;
  payload_json: unknown;
  attempts: number;
  next_attempt_at: Date | string;
  last_error: string | null;
  claimed_by: string | null;
  claimed_at: Date | string | null;
  published_at: Date | string | null;
  created_at: Date | string;
};

export async function publishExecutionOutboxBatch(
  options: PublishExecutionOutboxOptions,
): Promise<PublishExecutionOutboxResult> {
  await ensureExecutionOutboxStore();
  const ownerId = options.ownerId.trim();
  if (!ownerId) throw new Error('execution outbox ownerId is required');
  const batchSize = clampInteger(options.batchSize, 1, 100, 50);
  const claimMs = clampInteger(options.claimMs, 1_000, 10 * 60_000, 30_000);
  const baseDelayMs = clampInteger(options.baseDelayMs, 100, 60_000, 1_000);
  const maxDelayMs = clampInteger(options.maxDelayMs, baseDelayMs, 60 * 60_000, 60_000);
  const publish = options.publish ?? publishSessionEventNotification;
  const claimed = await claimExecutionOutbox(ownerId, batchSize, claimMs);
  let published = 0;
  let retried = 0;

  for (const record of claimed) {
    try {
      if (record.sessionEventId === undefined) {
        throw new Error(`execution outbox ${record.id} is missing session_event_id`);
      }
      await publish(record);
      await markExecutionOutboxPublished(record.id, ownerId);
      published++;
    } catch (error) {
      const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, record.attempts - 1));
      await markExecutionOutboxRetry(record.id, ownerId, error, delayMs);
      retried++;
    }
  }

  return { claimed: claimed.length, published, retried };
}

export async function readExecutionOutboxHealth(): Promise<ExecutionOutboxHealth> {
  await ensureExecutionOutboxStore();
  const rows = await getDb().query<{
    pending_count: string | number;
    claimed_count: string | number;
    legacy_count: string | number;
    oldest_pending_at: Date | string | null;
    oldest_pending_age_ms: string | number | null;
    legacy_through_id: string | number | null;
  }>(`
    SELECT
      count(*) FILTER (WHERE legacy = FALSE AND published_at IS NULL) AS pending_count,
      count(*) FILTER (WHERE legacy = FALSE AND published_at IS NULL AND claimed_at IS NOT NULL) AS claimed_count,
      count(*) FILTER (WHERE legacy = TRUE) AS legacy_count,
      min(created_at) FILTER (WHERE legacy = FALSE AND published_at IS NULL) AS oldest_pending_at,
      extract(epoch FROM (now() - min(created_at) FILTER (
        WHERE legacy = FALSE AND published_at IS NULL
      ))) * 1000 AS oldest_pending_age_ms,
      max(id) FILTER (WHERE legacy = TRUE) AS legacy_through_id
    FROM execution_outbox
  `);
  const row = rows.rows[0];
  return {
    pendingCount: Number(row?.pending_count ?? 0),
    claimedCount: Number(row?.claimed_count ?? 0),
    legacyCount: Number(row?.legacy_count ?? 0),
    oldestPendingAt: toIso(row?.oldest_pending_at),
    oldestPendingAgeMs: Math.max(0, Math.floor(Number(row?.oldest_pending_age_ms ?? 0))),
    legacyThroughId: optionalNumber(row?.legacy_through_id),
  };
}

async function claimExecutionOutbox(
  ownerId: string,
  batchSize: number,
  claimMs: number,
): Promise<ExecutionOutboxRecord[]> {
  return withDbClient(async client => {
    await client.query('BEGIN');
    try {
      const rows = await client.query<ExecutionOutboxRow>(`
        WITH ready AS (
          SELECT id
          FROM execution_outbox
          WHERE published_at IS NULL
            AND legacy = FALSE
            AND next_attempt_at <= now()
            AND (claimed_at IS NULL OR claimed_at <= now() - ($3::text || ' milliseconds')::interval)
          ORDER BY next_attempt_at ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $2
        )
        UPDATE execution_outbox outbox
        SET claimed_by = $1,
            claimed_at = now(),
            attempts = outbox.attempts + 1
        FROM ready
        WHERE outbox.id = ready.id
        RETURNING outbox.*
      `, [ownerId, batchSize, claimMs]);
      await client.query('COMMIT');
      return rows.rows.map(rowToExecutionOutbox);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}

async function markExecutionOutboxPublished(id: number, ownerId: string): Promise<void> {
  await getDb().query(`
    UPDATE execution_outbox
    SET published_at = now(), claimed_by = NULL, claimed_at = NULL, last_error = NULL
    WHERE id = $1 AND claimed_by = $2 AND published_at IS NULL
  `, [id, ownerId]);
}

async function markExecutionOutboxRetry(
  id: number,
  ownerId: string,
  error: unknown,
  delayMs: number,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
  await getDb().query(`
    UPDATE execution_outbox
    SET claimed_by = NULL,
        claimed_at = NULL,
        last_error = $3,
        next_attempt_at = now() + ($4::text || ' milliseconds')::interval
    WHERE id = $1 AND claimed_by = $2 AND published_at IS NULL
  `, [id, ownerId, message, delayMs]);
}

async function publishSessionEventNotification(record: ExecutionOutboxRecord): Promise<void> {
  await getDb().notify('session_events', JSON.stringify({
    session_id: record.sessionId,
    event_id: record.sessionEventId,
    type: record.eventType,
  }));
}

function rowToExecutionOutbox(row: ExecutionOutboxRow): ExecutionOutboxRecord {
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    runSpecId: row.run_spec_id ?? undefined,
    entityType: row.entity_type,
    entityId: row.entity_id,
    eventType: row.event_type,
    sessionEventId: optionalNumber(row.session_event_id),
    payload: normalizeObject(row.payload_json),
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: toIso(row.next_attempt_at) ?? new Date(0).toISOString(),
    lastError: row.last_error ?? undefined,
    claimedBy: row.claimed_by ?? undefined,
    claimedAt: toIso(row.claimed_at),
    publishedAt: toIso(row.published_at),
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

function normalizeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value!)));
}

function optionalNumber(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function toIso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
