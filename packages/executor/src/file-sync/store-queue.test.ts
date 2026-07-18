/**
 * Regression tests for the file-sync queue dead-letter / max-retry / heartbeat
 * behavior.
 *
 * The bug being fixed: reapStaleTransferring always reset 'transferring' back
 * to 'ready' with no attempt cap, so a perpetually-failing file (unreadable,
 * permission denied, etc.) was retried forever. The fix moves items to a
 * terminal 'dead_letter' state once attempts >= MAX_ATTEMPTS, and adds a
 * heartbeat (lease refresh) + manual requeue for recovery.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '@los/infra/db';
import { createFileSyncStore } from './store.js';
import { createScanner } from './scanner.js';
import { dequeueReadyItems, enqueueItems, reapStaleTransferring, heartbeatTransferring, requeueDeadLetter, getQueueStats } from './store-queue.js';

const NODE_ID = 'test-store-queue';
const FOLDER = 'test-dlq';

function tempDir() { return mkdtempSync(join(tmpdir(), 'los-dlq-test-')); }

/** Enqueue a single ready item for a folder. The scanner creates the folder
 *  row (FK target); queue population is done by enqueueItems, which in
 *  production is called from runSyncQueue. */
async function enqueueOne(folderId: string, filePath: string): Promise<void> {
  await enqueueItems(folderId, [{ filePath, size: 1, mtimeNs: 0 }]);
}

async function cleanup(db: ReturnType<typeof getDb>) {
  await db.query(`DELETE FROM file_sync_queue WHERE folder_id LIKE $1`, [`folder-${NODE_ID}%`]).catch(() => {});
  await db.query(`DELETE FROM file_sync_entries WHERE folder_id LIKE $1`, [`folder-${NODE_ID}%`]).catch(() => {});
  await db.query(`DELETE FROM file_sync_folders WHERE node_id = $1`, [NODE_ID]).catch(() => {});
}

/** Force an item's attempts count to simulate prior failed retries. */
async function setAttempts(db: ReturnType<typeof getDb>, folderId: string, attempts: number): Promise<void> {
  await db.query(`UPDATE file_sync_queue SET attempts = $2 WHERE folder_id = $1`, [folderId, attempts]);
}

async function getState(db: ReturnType<typeof getDb>, folderId: string): Promise<{ state: string; attempts: number; lastError: string | null }> {
  const r = await db.query<{ state: string; attempts: number; last_error: string | null }>(
    `SELECT state, attempts, last_error FROM file_sync_queue WHERE folder_id = $1`,
    [folderId],
  );
  return { state: r.rows[0].state, attempts: r.rows[0].attempts, lastError: r.rows[0].last_error };
}

test('reapStaleTransferring moves items to dead_letter once attempts reach the cap', async () => {
  const db = getDb();
  const store = createFileSyncStore();
  const { scanFolder } = createScanner(store, NODE_ID);
  const root = tempDir();
  try {
    writeFileSync(join(root, 'failing.txt'), 'x', 'utf-8');
    const scan = await scanFolder(FOLDER, root, 'full');
    const folderId = scan.folderId;
    await enqueueOne(folderId, 'failing.txt');

    // Claim the item (ready -> transferring, attempts 0 -> 1), then simulate
    // prior failures by bumping attempts to the cap.
    const claimed = await dequeueReadyItems(folderId, 1);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].state, 'transferring');
    await setAttempts(db, folderId, 5);

    // Reap with a 0ms threshold so the 'transferring' item is immediately stale.
    await reapStaleTransferring(0, folderId);
    const after = await getState(db, folderId);
    assert.equal(after.state, 'dead_letter', 'item at max attempts must go to dead_letter, not back to ready');
    assert.match(after.lastError ?? '', /dead_letter: max attempts/);
  } finally {
    await cleanup(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('reapStaleTransferring retries items that have not exhausted attempts', async () => {
  const db = getDb();
  const store = createFileSyncStore();
  const { scanFolder } = createScanner(store, NODE_ID);
  const root = tempDir();
  try {
    writeFileSync(join(root, 'transient.txt'), 'x', 'utf-8');
    const scan = await scanFolder(FOLDER, root, 'full');
    const folderId = scan.folderId;
    await enqueueOne(folderId, 'transient.txt');

    await dequeueReadyItems(folderId, 1); // -> transferring, attempts=1
    await setAttempts(db, folderId, 2); // below cap of 5

    await reapStaleTransferring(0, folderId);
    const after = await getState(db, folderId);
    assert.equal(after.state, 'ready', 'item below max attempts should be requeued for retry');
    assert.match(after.lastError ?? '', /stale: no heartbeat/);
  } finally {
    await cleanup(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('requeueDeadLetter moves a dead_letter item back to ready', async () => {
  const db = getDb();
  const store = createFileSyncStore();
  const { scanFolder } = createScanner(store, NODE_ID);
  const root = tempDir();
  try {
    writeFileSync(join(root, 'recovered.txt'), 'x', 'utf-8');
    const scan = await scanFolder(FOLDER, root, 'full');
    const folderId = scan.folderId;
    const queueId = `queue-${folderId}-${encodeURIComponent('recovered.txt')}`;
    await enqueueOne(folderId, 'recovered.txt');

    // Force into dead_letter.
    await dequeueReadyItems(folderId, 1);
    await setAttempts(db, folderId, 5);
    await reapStaleTransferring(0, folderId);
    assert.equal((await getState(db, folderId)).state, 'dead_letter');

    await requeueDeadLetter(queueId, true);
    const after = await getState(db, folderId);
    assert.equal(after.state, 'ready');
    assert.equal(after.attempts, 0, 'resetAttempts=true should zero the counter');
    assert.equal(after.lastError, null);
  } finally {
    await cleanup(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('heartbeatTransferring refreshes updated_at on a transferring item', async () => {
  const db = getDb();
  const store = createFileSyncStore();
  const { scanFolder } = createScanner(store, NODE_ID);
  const root = tempDir();
  try {
    writeFileSync(join(root, 'long.txt'), 'x', 'utf-8');
    const scan = await scanFolder(FOLDER, root, 'full');
    const folderId = scan.folderId;
    const queueId = `queue-${folderId}-${encodeURIComponent('long.txt')}`;
    await enqueueOne(folderId, 'long.txt');

    await dequeueReadyItems(folderId, 1); // -> transferring
    // Force an old updated_at so the heartbeat refresh is observable.
    await db.query(`UPDATE file_sync_queue SET updated_at = now() - interval '1 hour' WHERE queue_id = $1`, [queueId]);
    const before = await db.query<{ updated_at: Date }>(`SELECT updated_at FROM file_sync_queue WHERE queue_id = $1`, [queueId]);

    await heartbeatTransferring(queueId);
    const after = await db.query<{ updated_at: Date }>(`SELECT updated_at FROM file_sync_queue WHERE queue_id = $1`, [queueId]);
    assert.ok(after.rows[0].updated_at > before.rows[0].updated_at, 'heartbeat must refresh updated_at');

    // Heartbeat does not change the state away from 'transferring'.
    assert.equal((await getState(db, folderId)).state, 'transferring');
  } finally {
    await cleanup(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('getQueueStats reports the dead_letter state', async () => {
  const db = getDb();
  const store = createFileSyncStore();
  const { scanFolder } = createScanner(store, NODE_ID);
  const root = tempDir();
  try {
    writeFileSync(join(root, 'stat.txt'), 'x', 'utf-8');
    const scan = await scanFolder(FOLDER, root, 'full');
    const folderId = scan.folderId;
    await enqueueOne(folderId, 'stat.txt');

    await dequeueReadyItems(folderId, 1);
    await setAttempts(db, folderId, 5);
    await reapStaleTransferring(0, folderId);

    const stats = await getQueueStats(folderId);
    assert.ok((stats.dead_letter ?? 0) >= 1, 'dead_letter count should be reported in stats');
  } finally {
    await cleanup(db);
    rmSync(root, { recursive: true, force: true });
  }
});
