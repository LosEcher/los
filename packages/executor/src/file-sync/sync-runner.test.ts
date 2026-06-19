import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '@los/infra/db';
import { createFileSyncStore } from './store.js';
import { createScanner } from './scanner.js';
import { runSyncQueue } from './sync-runner.js';

const NODE_ID = 'test-sync-runner';
const FOLDER = 'test-sync';

function tempDir() { return mkdtempSync(join(tmpdir(), 'los-sync-test-')); }

async function cleanupTestState(db: ReturnType<typeof getDb>) {
  await db.query(`DELETE FROM file_sync_queue WHERE folder_id LIKE $1`, [`folder-${NODE_ID}%`]).catch(() => {});
  await db.query(`DELETE FROM file_sync_entries WHERE folder_id LIKE $1`, [`folder-${NODE_ID}%`]).catch(() => {});
  await db.query(`DELETE FROM file_sync_manifests WHERE folder_id LIKE $1`, [`folder-${NODE_ID}%`]).catch(() => {});
  await db.query(`DELETE FROM file_sync_events`).catch(() => {});
  await db.query(`DELETE FROM file_sync_folders WHERE node_id = $1`, [NODE_ID]).catch(() => {});
}

test('sync-runner: processes ready item to done', async () => {
  const db = getDb();
  const store = createFileSyncStore();
  const { scanFolder } = createScanner(store, NODE_ID);
  const root = tempDir();
  try {
    writeFileSync(join(root, 'file.txt'), 'hello sync', 'utf-8');

    const scan = await scanFolder(FOLDER, root, 'full');
    assert.ok(scan.totalFiles >= 1);

    const result = await runSyncQueue({
      store,
      folderId: scan.folderId,
      localPath: root,
      nodeId: NODE_ID,
      maxConcurrency: 1,
      settleWindowMs: 0,
      maxRetries: 2,
    });

    assert.equal(result.processed, 1);
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 0);
  } finally {
    await cleanupTestState(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('sync-runner: settle window filters unstable files', async () => {
  const db = getDb();
  const store = createFileSyncStore();
  const { scanFolder } = createScanner(store, NODE_ID);
  const root = tempDir();
  try {
    writeFileSync(join(root, 'unstable.txt'), 'v1', 'utf-8');

    const scan = await scanFolder(FOLDER, root, 'full');
    // Immediately re-write — file changed less than settle window ago
    writeFileSync(join(root, 'unstable.txt'), 'v2', 'utf-8');
    await scanFolder(FOLDER, root, 'incremental');

    // With a very large settle window, no items should be stable
    const result = await runSyncQueue({
      store,
      folderId: scan.folderId,
      localPath: root,
      nodeId: NODE_ID,
      maxConcurrency: 1,
      settleWindowMs: 60_000,
      maxRetries: 2,
    });

    assert.equal(result.processed, 0);
  } finally {
    await cleanupTestState(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('sync-runner: missing file moves to reconcile', async () => {
  const db = getDb();
  const store = createFileSyncStore();
  const { scanFolder } = createScanner(store, NODE_ID);
  const root = tempDir();
  try {
    writeFileSync(join(root, 'vanish.txt'), 'will disappear', 'utf-8');

    const scan = await scanFolder(FOLDER, root, 'full');
    assert.ok(scan.totalFiles >= 1);

    // Delete the file before running sync
    rmSync(join(root, 'vanish.txt'));

    const result = await runSyncQueue({
      store,
      folderId: scan.folderId,
      localPath: root,
      nodeId: NODE_ID,
      maxConcurrency: 1,
      settleWindowMs: 0,
      maxRetries: 1,
    });

    assert.equal(result.reconcile, 1);
    assert.equal(result.succeeded, 0);
  } finally {
    await cleanupTestState(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('sync-runner: two concurrent runners skip due to advisory lock', async () => {
  const db = getDb();
  const store = createFileSyncStore();
  const { scanFolder } = createScanner(store, NODE_ID);
  const root = tempDir();
  try {
    writeFileSync(join(root, 'concurrent.txt'), 'locked', 'utf-8');
    const scan = await scanFolder(FOLDER, root, 'full');

    const [r1, r2] = await Promise.all([
      runSyncQueue({ store, folderId: scan.folderId, localPath: root, nodeId: NODE_ID, maxConcurrency: 1, settleWindowMs: 0, maxRetries: 1 }),
      runSyncQueue({ store, folderId: scan.folderId, localPath: root, nodeId: NODE_ID, maxConcurrency: 1, settleWindowMs: 0, maxRetries: 1 }),
    ]);

    // One should succeed (process the item), the other should skip (lock held)
    const skipped = [r1, r2].filter(r => r.processed === 0);
    const processed = [r1, r2].filter(r => r.processed > 0);
    assert.ok(skipped.length >= 1, 'at least one runner should skip due to lock');
    assert.ok(processed.length >= 1, 'at least one runner should process');
  } finally {
    await cleanupTestState(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('sync-runner: empty folder returns zeros', async () => {
  const store = createFileSyncStore();
  const { scanFolder } = createScanner(store, NODE_ID);
  const root = tempDir();
  try {
    await scanFolder('empty-sync', root, 'full');
    const result = await runSyncQueue({
      store,
      folderId: `folder-${NODE_ID}-empty-sync`,
      localPath: root,
      nodeId: NODE_ID,
      maxConcurrency: 1,
      settleWindowMs: 0,
      maxRetries: 2,
    });

    assert.equal(result.processed, 0);
    assert.equal(result.succeeded, 0);
    assert.equal(result.failed, 0);
    assert.equal(result.cooldown, 0);
    assert.equal(result.reconcile, 0);
  } finally {
    const db = getDb();
    await cleanupTestState(db);
    rmSync(root, { recursive: true, force: true });
  }
});
