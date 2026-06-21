// Sync runner: incremental sync queue following rclonemana's CONTINUOUS_SYNC_DESIGN state machine.
// States: ready → transferring → verifying → done | retry → cooldown | reconcile
import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import type { FileSyncStore } from './store.js';
import {
  enqueueItems,
  dequeueReadyItems,
  updateQueueState,
  batchDone,
  getQueueStats,
  reapStaleTransferring,
  pruneCompletedItems,
} from './store-queue.js';

const log = getLogger('file-sync-runner');

export type SyncRunnerResult = {
  folderId: string;
  processed: number;
  succeeded: number;
  failed: number;
  cooldown: number;
  reconcile: number;
};

export async function runSyncQueue(options: {
  store: FileSyncStore;
  folderId: string;
  localPath: string;
  nodeId: string;
  maxConcurrency: number;
  settleWindowMs: number;
  maxRetries: number;
}): Promise<SyncRunnerResult> {
  const { store, folderId, localPath, nodeId, maxConcurrency, settleWindowMs, maxRetries } = options;
  const resolvedRoot = resolve(localPath);
  const db = getDb();
  const lockKey = `file-sync-runner:${folderId}`;

  // Acquire per-folder advisory lock (non-blocking — skip if held)
  const lockResult = await db.query<{ locked: boolean }>(
    `SELECT pg_try_advisory_lock(hashtext('${lockKey}')) AS locked`,
  );
  if (!lockResult.rows[0]?.locked) {
    log.debug(`sync ${folderId}: lock held by another runner, skipping`);
    return { folderId, processed: 0, succeeded: 0, failed: 0, cooldown: 0, reconcile: 0 };
  }

  try {
    return await runCore({ store, folderId, resolvedRoot, nodeId, maxConcurrency, settleWindowMs, maxRetries });
  } finally {
    void db.query(`SELECT pg_advisory_unlock(hashtext('${lockKey}'))`).catch(() => {});
  }
}

async function runCore(options: {
  store: FileSyncStore;
  folderId: string;
  resolvedRoot: string;
  nodeId: string;
  maxConcurrency: number;
  settleWindowMs: number;
  maxRetries: number;
}): Promise<SyncRunnerResult> {
  const { store, folderId, resolvedRoot, nodeId, maxConcurrency, settleWindowMs, maxRetries } = options;
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let cooldown = 0;
  let reconcile = 0;

  // 1. Reap stale transferring items from previous crashed runs
  await reapStaleTransferring(300_000, folderId);

  // 2. Get changed files: modified or newly added from the last scan
  const now = new Date().toISOString();
  const changed = await store.listChangedFiles(folderId, 'pending');

  // 3. Settle-window filter: only queue files whose on-disk mtime is stable
  const ready: Array<{ filePath: string; size: number; mtimeNs: number }> = [];
  for (const entry of changed) {
    const mtimeMs = Math.floor(entry.mtimeNs / 1_000_000);
    const ageMs = Date.now() - mtimeMs;
    if (ageMs >= settleWindowMs) {
      ready.push({ filePath: entry.filePath, size: entry.size, mtimeNs: entry.mtimeNs });
    } else {
      log.debug(`sync ${folderId}: ${entry.filePath} still settling (mtime age ${ageMs}ms < ${settleWindowMs}ms settle window)`);
    }
  }

  // 4. Enqueue ready items
  if (ready.length > 0) {
    await enqueueItems(folderId, ready);
    await store.insertEvent({
      folderId,
      event: 'queued',
      nodeId,
      detail: { count: ready.length, settleWindowMs },
      seq: 0,
    });
  }

  // 5. Process queue in batches
  const limit = Math.max(1, maxConcurrency);
  let items = await dequeueReadyItems(folderId, limit);
  while (items.length > 0) {
    for (const item of items) {
      const fullPath = resolve(resolvedRoot, item.filePath);
      try {
        // Quick size check on disk
        const stat = statSync(fullPath);
        const currentSize = stat.size;
        const currentMtimeNs = Math.floor(stat.mtimeMs * 1_000_000);

        if (currentSize !== item.size || currentMtimeNs !== item.mtimeNs) {
          // File changed since enqueue — retry
          if (item.attempts < maxRetries) {
            await updateQueueState(item.queueId, 'retry',
              `size/mtime mismatch: expected ${item.size}/${item.mtimeNs}, got ${currentSize}/${currentMtimeNs}`);
            failed++;
          } else {
            await updateQueueState(item.queueId, 'cooldown',
              `exceeded ${maxRetries} retries: size/mtime unstable`);
            cooldown++;
          }
        } else {
          await updateQueueState(item.queueId, 'done');
          succeeded++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('ENOENT')) {
          await updateQueueState(item.queueId, 'reconcile', `source file missing: ${msg}`);
          reconcile++;
        } else if (item.attempts < maxRetries) {
          await updateQueueState(item.queueId, 'retry', msg);
          failed++;
        } else {
          await updateQueueState(item.queueId, 'cooldown', msg);
          cooldown++;
        }
      }
      processed++;
    }

    items = await dequeueReadyItems(folderId, limit);
  }

  // 6. Record summary event
  const stats = await getQueueStats(folderId);
  await store.insertEvent({
    folderId,
    event: 'sync_complete',
    nodeId,
    detail: { processed, succeeded, failed, cooldown, reconcile, queueStats: stats },
    seq: 0,
  });

  // 7. Cleanup: prune completed items older than retention
  await pruneCompletedItems(folderId);

  log.info(
    `sync ${folderId}: done ${succeeded}, failed ${failed}, cooldown ${cooldown}, reconcile ${reconcile} (${processed} processed)`,
  );

  return { folderId, processed, succeeded, failed, cooldown, reconcile };
}
