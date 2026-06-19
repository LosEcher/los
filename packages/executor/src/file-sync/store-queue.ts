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

const QUEUE_STATES = ['ready', 'transferring', 'verifying', 'done', 'retry', 'cooldown', 'reconcile'] as const;

export async function enqueueItems(
  folderId: string,
  entries: Array<{ filePath: string; size: number; mtimeNs: number }>,
): Promise<number> {
  if (!entries.length) return 0;
  const db = getDb();
  const now = new Date().toISOString();
  const values: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  for (const e of entries) {
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
           WHEN file_sync_queue.state IN ('retry','cooldown') AND file_sync_queue.updated_at < now() - interval '15 minutes' THEN 'ready'
           ELSE file_sync_queue.state
         END,
         attempts = CASE
           WHEN file_sync_queue.state IN ('retry','cooldown') AND file_sync_queue.updated_at < now() - interval '15 minutes' THEN file_sync_queue.attempts
           ELSE file_sync_queue.attempts
         END,
         last_error = CASE
           WHEN file_sync_queue.state IN ('retry','cooldown') AND file_sync_queue.updated_at < now() - interval '15 minutes' THEN NULL
           ELSE file_sync_queue.last_error
         END,
         updated_at = EXCLUDED.updated_at`,
      params,
    );
    log.debug(`enqueued ${entries.length} items for folder ${folderId}, affected ${result.rows.length}`);
    return result.rows.length;
  } catch (err) {
    log.warn(`enqueueItems failed for folder ${folderId}: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
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
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const params: unknown[] = [cutoff];
  let where = "state = 'transferring' AND updated_at < $1";
  if (folderId) {
    params.push(folderId);
    where = `folder_id = $${params.length} AND ${where}`;
  }

  const result = await db.query<QueueRow>(
    `UPDATE file_sync_queue
     SET state = 'ready', last_error = 'stale: no heartbeat within ${maxAgeMs}ms', updated_at = now()
     WHERE ${where}
     RETURNING *`,
    params,
  );
  if (result.rows.length > 0) {
    log.info(`reaped ${result.rows.length} stale transferring items${folderId ? ` for folder ${folderId}` : ''}`);
  }
  return result.rows.length;
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
