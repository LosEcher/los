import { getDb, withDbClient, type DbTransactionClient } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import { ensureExecutionOutboxStore } from './execution-persistence.js';
import { appendSessionEvent } from './session-events.js';
import { ensureDeadLetterStore, writeDeadLetterEvent } from './dead-letter.js';

const log = getLogger('execution-outbox');

/**
 * How many failed delivery attempts a row gets before it is handed to the
 * dead-letter table. Aligned with the existing feed-analysis callback outbox
 * default (`.max(20).default(8)` in `@los/infra` config) so the repo keeps one
 * magic number instead of three.
 *
 * Not configurable on purpose: a hot-pushable threshold would make "which gate
 * was this process running?" unrecoverable from the start-up hash
 * (docs/architecture/2026-10-10-control-plane-truth-remediation.md §3).
 */
const EXECUTION_OUTBOX_MAX_ATTEMPTS = 8;

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
  /** Set when the row exhausted its attempts and was handed to the dead-letter table. */
  deadLetteredAt?: string;
  createdAt: string;
}

export interface ExecutionOutboxHealth {
  pendingCount: number;
  claimedCount: number;
  deadLetteredCount: number;
  legacyCount: number;
  oldestPendingAt?: string;
  oldestPendingAgeMs: number;
  legacyThroughId?: number;
}

export interface PublishExecutionOutboxResult {
  claimed: number;
  published: number;
  retried: number;
  /** Rows that hit {@link EXECUTION_OUTBOX_MAX_ATTEMPTS} on this pass. */
  deadLettered: number;
}

export interface PublishExecutionOutboxOptions {
  ownerId: string;
  batchSize?: number;
  claimMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  publish?: (record: ExecutionOutboxRecord) => Promise<void>;
  /** 白名单：只认领这些 entity_type（如 DSH 事件转发器只认 'dsh_event'）。 */
  entityTypes?: string[];
  /** 黑名单：排除这些 entity_type（会话事件发布器要排除 'dsh_event'，否则会把
   *  DSH 事件行当成"缺 session_event_id"的行重试到死）。 */
  excludeEntityTypes?: string[];
  /** 是否要求 session_event_id 存在。缺省 = 用默认会话事件发布器时才要求；
   *  自定义 publish（如 DSH webhook）显式传 false。 */
  requiresSessionEventId?: boolean;
  /**
   * Injection seam for the dead-letter write used by the attempt cap. Production
   * always uses `writeDeadLetterEvent`; tests use it to force the INSERT to fail
   * so the SAVEPOINT path (cap still commits, no dead-letter row) is exercised.
   * This exists because the alternative — dropping the savepoint — would let a
   * failed INSERT abort the cap and put the poison row back in the claim set.
   */
  writeDeadLetter?: typeof writeDeadLetterEvent;
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
  dead_lettered_at?: Date | string | null;
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
  const requiresSessionEventId = options.requiresSessionEventId ?? options.publish === undefined;
  const claimed = await claimExecutionOutbox({
    ownerId,
    batchSize,
    claimMs,
    entityTypes: options.entityTypes,
    excludeEntityTypes: options.excludeEntityTypes,
  });
  let published = 0;
  let retried = 0;
  let deadLettered = 0;

  for (const record of claimed) {
    try {
      if (requiresSessionEventId && record.sessionEventId === undefined) {
        throw new Error(`execution outbox ${record.id} is missing session_event_id`);
      }
      await publish(record);
      await markExecutionOutboxPublished(record.id, ownerId);
      published++;
    } catch (error) {
      if (record.attempts >= EXECUTION_OUTBOX_MAX_ATTEMPTS) {
        // Terminal failure: hand the row to the existing dead-letter table and
        // stop claiming it. No further `next_attempt_at` is written — the row is
        // no longer retried, and nothing is auto-replayed.
        await deadLetterExhaustedOutboxRecord(record, ownerId, error, options.writeDeadLetter ?? writeDeadLetterEvent);
        deadLettered++;
        continue;
      }
      const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, record.attempts - 1));
      await markExecutionOutboxRetry(record.id, ownerId, error, delayMs);
      retried++;
    }
  }

  return { claimed: claimed.length, published, retried, deadLettered };
}

export async function readExecutionOutboxHealth(): Promise<ExecutionOutboxHealth> {
  await ensureExecutionOutboxStore();
  const rows = await getDb().query<{
    pending_count: string | number;
    claimed_count: string | number;
    dead_lettered_count: string | number;
    legacy_count: string | number;
    oldest_pending_at: Date | string | null;
    oldest_pending_age_ms: string | number | null;
    legacy_through_id: string | number | null;
  }>(`
    SELECT
      count(*) FILTER (WHERE legacy = FALSE AND published_at IS NULL AND dead_lettered_at IS NULL) AS pending_count,
      count(*) FILTER (WHERE legacy = FALSE AND published_at IS NULL AND dead_lettered_at IS NULL AND claimed_at IS NOT NULL) AS claimed_count,
      count(*) FILTER (WHERE legacy = FALSE AND dead_lettered_at IS NOT NULL) AS dead_lettered_count,
      count(*) FILTER (WHERE legacy = TRUE) AS legacy_count,
      min(created_at) FILTER (WHERE legacy = FALSE AND published_at IS NULL AND dead_lettered_at IS NULL) AS oldest_pending_at,
      extract(epoch FROM (now() - min(created_at) FILTER (
        WHERE legacy = FALSE AND published_at IS NULL AND dead_lettered_at IS NULL
      ))) * 1000 AS oldest_pending_age_ms,
      max(id) FILTER (WHERE legacy = TRUE) AS legacy_through_id
    FROM execution_outbox
  `);
  const row = rows.rows[0];
  return {
    pendingCount: Number(row?.pending_count ?? 0),
    claimedCount: Number(row?.claimed_count ?? 0),
    deadLetteredCount: Number(row?.dead_lettered_count ?? 0),
    legacyCount: Number(row?.legacy_count ?? 0),
    oldestPendingAt: toIso(row?.oldest_pending_at),
    oldestPendingAgeMs: Math.max(0, Math.floor(Number(row?.oldest_pending_age_ms ?? 0))),
    legacyThroughId: optionalNumber(row?.legacy_through_id),
  };
}

async function claimExecutionOutbox(input: {
  ownerId: string;
  batchSize: number;
  claimMs: number;
  entityTypes?: string[];
  excludeEntityTypes?: string[];
}): Promise<ExecutionOutboxRecord[]> {
  const { ownerId, batchSize, claimMs } = input;
  // 两维过滤都用"未传即不过滤"的语义（NULL 参数短路），保证既有调用方行为逐位不变。
  const includeTypes = input.entityTypes && input.entityTypes.length > 0 ? input.entityTypes : null;
  const excludeTypes = input.excludeEntityTypes && input.excludeEntityTypes.length > 0 ? input.excludeEntityTypes : null;
  return withDbClient(async client => {
    await client.query('BEGIN');
    try {
      const rows = await client.query<ExecutionOutboxRow>(`
        WITH ready AS (
          SELECT id
          FROM execution_outbox
          WHERE published_at IS NULL
            AND legacy = FALSE
            AND dead_lettered_at IS NULL
            AND next_attempt_at <= now()
            AND ($4::text[] IS NULL OR entity_type = ANY($4::text[]))
            AND ($5::text[] IS NULL OR NOT (entity_type = ANY($5::text[])))
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
      `, [ownerId, batchSize, claimMs, includeTypes, excludeTypes]);
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

/**
 * Terminal handling for a row that failed every allowed attempt.
 *
 * This runs on a **new** transaction, because the claim transaction that
 * incremented `attempts` was already committed (see `claimExecutionOutbox`).
 * Order is deliberate:
 *
 *   1. `UPDATE ... dead_lettered_at = now()` and clear the claim, so the row
 *      stops being claimable even if everything after this point fails.
 *      No `next_attempt_at` is written.
 *   2. A SAVEPOINT around the dead-letter INSERT only. Without it, a failed
 *      INSERT would poison the transaction and the subsequent COMMIT would be
 *      rejected (`current transaction is aborted`), which would put the poison
 *      row back in the claimable set. With it, an INSERT failure still commits
 *      the cap — the dead-letter row may legitimately be zero in that case.
 *   3. `appendSessionEvent` after the COMMIT, on its own connection. Passing the
 *      transaction client here would reintroduce the same abort problem.
 */
async function deadLetterExhaustedOutboxRecord(
  record: ExecutionOutboxRecord,
  ownerId: string,
  error: unknown,
  writeDead: typeof writeDeadLetterEvent,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
  let committed = false;
  let eventId: string | undefined;

  // Warm the dead-letter schema on its own connection *before* opening the
  // transaction. `writeDeadLetterEvent` calls `ensureDeadLetterStore()`, which may
  // run DDL — DDL inside our transaction would take its own locks and, if it
  // failed, would abort the transaction outside the SAVEPOINT we rely on.
  // Failing here is non-fatal: the INSERT below then fails inside the savepoint
  // and is reported, while the cap still commits.
  await ensureDeadLetterStore().catch(() => undefined);

  try {
    await withDbClient(async (client: DbTransactionClient) => {
      await client.query('BEGIN');
      await client.query(
        `UPDATE execution_outbox
            SET dead_lettered_at = now(),
                claimed_by = NULL,
                claimed_at = NULL,
                last_error = $3
          WHERE id = $1 AND claimed_by = $2 AND published_at IS NULL`,
        [record.id, ownerId, message],
      );

      // Foreign keys: `execution_outbox.run_spec_id` can dangle (no FK on that
      // column), but `dead_letter_events` has FKs to task_runs and run_specs. Fill
      // each only when the target row exists, otherwise the INSERT fails.
      const exists = async (table: 'run_specs' | 'task_runs', id: string) => {
        const rows = await client.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
        return rows.rows.length > 0;
      };
      const runSpecId = record.runSpecId && (await exists('run_specs', record.runSpecId))
        ? record.runSpecId
        : undefined;
      const taskRunId = record.entityType === 'task_run' && (await exists('task_runs', record.entityId))
        ? record.entityId
        : undefined;

      await client.query('SAVEPOINT outbox_dead_letter');
      try {
        const dead = await writeDead({
          taskRunId,
          runSpecId,
          reason: 'outbox_exhausted',
          originalError: message,
          eventPayload: {
            outboxId: record.id,
            entityType: record.entityType,
            entityId: record.entityId,
            eventType: record.eventType,
            attempts: record.attempts,
            sessionId: record.sessionId,
            // Kept even when the FK column above had to be NULL, so a dangling
            // run_spec_id is still visible to whoever disposes of this row.
            runSpecId: record.runSpecId,
            lastError: message,
          },
          client,
        });
        eventId = dead.id;
        await client.query('RELEASE SAVEPOINT outbox_dead_letter');
      } catch (insertError) {
        const insertMessage = insertError instanceof Error ? insertError.message : String(insertError);
        log.warn(
          `outbox ${record.id} dead-letter insert failed (cap still committed): ${insertMessage}`,
        );
        await client.query('ROLLBACK TO SAVEPOINT outbox_dead_letter');
      }

      await client.query('COMMIT');
      committed = true;
    });
  } catch (error_) {
    log.warn(
      `outbox ${record.id} dead-letter transaction failed: ${error_ instanceof Error ? error_.message : String(error_)}`,
    );
    return;
  }

  if (!committed) return;

  // Own connection, after the commit. A failure here is logged and swallowed —
  // it must not undo a cap that is already durable.
  try {
    await appendSessionEvent({
      sessionId: record.sessionId,
      type: 'operator_attention_required',
      source: 'execution_outbox',
      payload: {
        event: 'execution_outbox_dead_lettered',
        dlqEventId: eventId,
        outboxId: record.id,
        entityType: record.entityType,
        entityId: record.entityId,
        eventType: record.eventType,
        attempts: record.attempts,
        reason: 'outbox_exhausted',
        severity: 'high',
      },
    });
  } catch (eventError) {
    log.warn(
      `outbox ${record.id} dead-letter session event failed: ${eventError instanceof Error ? eventError.message : String(eventError)}`,
    );
  }
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
    deadLetteredAt: toIso(row.dead_lettered_at),
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
