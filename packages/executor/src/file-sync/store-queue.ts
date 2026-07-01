// Store-queue: PostgreSQL-backed file_sync_queue operations.
// Extracted from store.ts to keep it under the 400-line gate.
import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import type { FileSyncQueueItem } from './store.js';

const log = getLogger('file-sync-store-queue');

interface QueueRow {
  queue_id: string;
  folder_id: string;
  file_path: string;
  size: string;
  mtime_ns: string;
  state: string;
  attempts: number;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function rowToQueue(row: QueueRow): FileSyncQueueItem {
  return {
    queueId: row.queue_id,
    folderId: row.folder_id,
    filePath: row.file_path,
    size: Number(row.size),
    mtimeNs: Number(row.mtime_ns),
    state: row.state as FileSyncQueueItem['state'],
    attempts: row.attempts,
    lastError: row.last_error ?? undefined,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

const QUEUE_STATES = ['ready', 'transferring', 'verifying', 'done', 'retry', 'cooldown', 'reconcile', 'dead_letter'] as const;

/** Maximum entries per batch INSERT to avoid PostgreSQL bind parameter overflow (65,535 limit). */
const MAX_BATCH_SIZE = 500;

/**
 * Max transfer attempts before a file is moved to the dead_letter state.
 * Without this cap, a perpetually-failing file (e.g. unreadable, permission
 * denied) would be reaped from 'transferring' back to 'ready' and retried
 * forever. Mirrors the max-retry-then-DLQ pattern used by the task_runs queue.
 */
const MAX_ATTEMPTS = 5;

export async function enqueueItems(
  folderId: string,
  entries: Array<{ filePath: string; size: number; mtimeNs: number }>,
): Promise<number> {
  if (!entries.length) return 0;
  const db = getDb();
  const now = new Date().toISOString();
  let total = 0;

  // Chunk to avoid PostgreSQL bind message parameter overflow
  for (let offset = 0; offset < entries.length; offset += MAX_BATCH_SIZE) {
    const chunk = entries.slice(offset, offset + MAX_BATCH_SIZE);
    const values: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    for (const e of chunk) {
      const queueId = `queue-${folderId}-${encodeURIComponent(e.filePath)}`;
      params.push(queueId, folderId, e.filePath, e.size, e.mtimeNs, now, now);
      values.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, 'ready', 0, null, $${idx + 5}, $${idx + 6})`);
      idx += 7;
    }

    try {
      const result = await db.query(
        `INSERT INTO file_sync_queue (queue_id, folder_id, file_path, size, mtime_ns, state, attempts, last_error, created_at, updated_at)
         VALUES ${values.join(', ')}
         ON CONFLICT (queue_id) DO UPDATE SET
           size = EXCLUDED.size,
           mtime_ns = EXCLUDED.mtime_ns,
           state = CASE
             WHEN file_sync_queue.state IN ('retry','cooldown') AND file_sync_queue.updated_at < now() - interval '15 minutes' AND file_sync_queue.attempts >= ${MAX_ATTEMPTS} THEN 'dead_letter'
             WHEN file_sync_queue.state IN ('retry','cooldown') AND file_sync_queue.updated_at < now() - interval '15 minutes' THEN 'ready'
             ELSE file_sync_queue.state
           END,
           attempts = file_sync_queue.attempts,
           last_error = CASE
             WHEN file_sync_queue.state IN ('retry','cooldown') AND file_sync_queue.updated_at < now() - interval '15 minutes' AND file_sync_queue.attempts >= ${MAX_ATTEMPTS} THEN 'dead_letter: max attempts (' || file_sync_queue.attempts || ') exceeded'
             WHEN file_sync_queue.state IN ('retry','cooldown') AND file_sync_queue.updated_at < now() - interval '15 minutes' THEN NULL
             ELSE file_sync_queue.last_error
           END,
           updated_at = EXCLUDED.updated_at`,
        params,
      );
      total += result.rows.length;
    } catch (err) {
      log.warn(`enqueueItems failed for folder ${folderId} (chunk ${Math.floor(offset / MAX_BATCH_SIZE) + 1}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (total > 0) {
    log.debug(`enqueued ${total} items for folder ${folderId} (${entries.length} total in ${Math.ceil(entries.length / MAX_BATCH_SIZE)} chunk(s))`);
  }
  return total;
}

export async function dequeueReadyItems(
  folderId: string,
  limit: number = 1,
): Promise<FileSyncQueueItem[]> {
  const db = getDb();
  const result = await db.query<QueueRow>(
    `WITH selected AS (
       SELECT queue_id FROM file_sync_queue
       WHERE folder_id = $1 AND state = 'ready'
       ORDER BY created_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     UPDATE file_sync_queue q
     SET state = 'transferring',
         attempts = q.attempts + 1,
         updated_at = now()
     FROM selected
     WHERE q.queue_id = selected.queue_id
     RETURNING q.*`,
    [folderId, Math.max(1, Math.min(limit, 100))],
  );
  if (result.rows.length > 0) {
    log.debug(`dequeued ${result.rows.length} ready items for folder ${folderId}`);
  }
  return result.rows.map(rowToQueue);
}

export async function updateQueueState(
  queueId: string,
  state: FileSyncQueueItem['state'],
  lastError?: string,
): Promise<void> {
  if (!QUEUE_STATES.includes(state)) return;
  const db = getDb();
  await db.query(
    `UPDATE file_sync_queue
     SET state = $2, last_error = $3, updated_at = now()
     WHERE queue_id = $1`,
    [queueId, state, lastError ?? null],
  );
}

export async function batchDone(queueIds: string[]): Promise<void> {
  if (!queueIds.length) return;
  const db = getDb();
  await db.query(
    `UPDATE file_sync_queue SET state = 'done', updated_at = now()
     WHERE queue_id = ANY($1)`,
    [queueIds],
  );
}

export async function getQueueStats(
  folderId: string,
): Promise<Record<string, number>> {
  const db = getDb();
  const result = await db.query<{ state: string; count: string }>(
    `SELECT state, COUNT(*)::text AS count
     FROM file_sync_queue
     WHERE folder_id = $1
     GROUP BY state`,
    [folderId],
  );
  const stats: Record<string, number> = {};
  for (const row of result.rows) {
    stats[row.state] = Number(row.count);
  }
  return stats;
}

export async function reapStaleTransferring(
  maxAgeMs: number = 300_000,
  folderId?: string,
): Promise<number> {
  const db = getDb();
  const staleAgeMs = Math.max(0, maxAgeMs);
  const params: unknown[] = [staleAgeMs, MAX_ATTEMPTS];
  let where = "state = 'transferring' AND updated_at <= now() - ($1::double precision * interval '1 millisecond')";
  if (folderId) {
    params.push(folderId);
    where = `folder_id = $${params.length} AND ${where}`;
  }

  // A stale transfer is reaped back to 'ready' for retry — unless it has
  // already exhausted MAX_ATTEMPTS, in which case it moves to 'dead_letter'
  // so a perpetually-failing file does not loop forever.
  const result = await db.query<QueueRow>(
    `UPDATE file_sync_queue
     SET state = CASE WHEN attempts >= $2 THEN 'dead_letter' ELSE 'ready' END,
         last_error = CASE WHEN attempts >= $2 THEN 'dead_letter: max attempts (' || attempts || ') exceeded after stale transfer' ELSE 'stale: no heartbeat within ${maxAgeMs}ms' END,
         updated_at = now()
     WHERE ${where}
     RETURNING *`,
    params,
  );
  const deadLettered = result.rows.filter(r => r.state === 'dead_letter').length;
  if (result.rows.length > 0) {
    log.info(`reaped ${result.rows.length} stale transferring items${folderId ? ` for folder ${folderId}` : ''}${deadLettered > 0 ? ` (${deadLettered} moved to dead_letter)` : ''}`);
  }
  return result.rows.length;
}

/**
 * Refresh the lease on a 'transferring' item so a long transfer is not reaped
 * by reapStaleTransferring. The transfer loop should call this periodically
 * (well within maxAgeMs) for transfers that may exceed the stale threshold.
 * No-op if the item is not currently 'transferring'.
 */
export async function heartbeatTransferring(queueId: string): Promise<void> {
  const db = getDb();
  await db.query(
    `UPDATE file_sync_queue SET updated_at = now()
     WHERE queue_id = $1 AND state = 'transferring'`,
    [queueId],
  );
}

/**
 * Manually requeue a dead_letter item back to 'ready' for retry, resetting its
 * error state. Used by operators after fixing the underlying cause (permissions,
 * disk space, etc.). Does not reset attempts — callers may bump the attempt
 * budget by resetting attempts to 0 first if they want a fresh retry budget.
 */
export async function requeueDeadLetter(queueId: string, resetAttempts = false): Promise<void> {
  const db = getDb();
  await db.query(
    `UPDATE file_sync_queue
     SET state = 'ready', last_error = NULL, updated_at = now()
     ${resetAttempts ? ', attempts = 0' : ''}
     WHERE queue_id = $1 AND state = 'dead_letter'`,
    [queueId],
  );
}

export async function pruneCompletedItems(
  folderId: string,
  retentionMs: number = 86_400_000,
): Promise<number> {
  const db = getDb();
  const cutoff = new Date(Date.now() - retentionMs).toISOString();
  const result = await db.query(
    `DELETE FROM file_sync_queue
     WHERE folder_id = $1 AND state = 'done' AND updated_at < $2`,
    [folderId, cutoff],
  );
  if (result.rows.length > 0) {
    log.debug(`pruned ${result.rows.length} completed items for folder ${folderId}`);
  }
  return result.rows.length;
}
