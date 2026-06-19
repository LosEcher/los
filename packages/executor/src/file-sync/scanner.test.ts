import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '@los/infra/db';
import { createFileSyncStore } from './store.js';
import { createScanner } from './scanner.js';

const NODE_ID = 'test-scanner';
const FOLDER = 'test-folder';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'los-scanner-test-'));
}

async function cleanupTestState(db: ReturnType<typeof getDb>) {
  await db.query(`DELETE FROM file_sync_entries WHERE folder_id LIKE $1`, [`folder-${NODE_ID}%`]).catch(() => {});
  await db.query(`DELETE FROM file_sync_events`).catch(() => {});
  await db.query(`DELETE FROM file_sync_queue`).catch(() => {});
  await db.query(`DELETE FROM file_sync_manifests`).catch(() => {});
  await db.query(`DELETE FROM file_sync_folders WHERE node_id = $1`, [NODE_ID]).catch(() => {});
}

test('scanner: full scan detects all files', async () => {
  const db = getDb();
  const root = tempDir();
  try {
    writeFileSync(join(root, 'file1.txt'), 'hello', 'utf-8');
    writeFileSync(join(root, 'file2.txt'), 'world', 'utf-8');
    mkdirSync(join(root, 'subdir'));
    writeFileSync(join(root, 'subdir', 'file3.txt'), 'nested', 'utf-8');

    const store = createFileSyncStore();
    const { scanFolder } = createScanner(store, NODE_ID);
    const result = await scanFolder(FOLDER, root, 'full');

    assert.equal(result.totalFiles, 3);
    assert.ok(result.added >= 2);
    assert.equal(result.removed, 0);
    assert.ok(result.durationMs >= 0);
    assert.ok(result.scanId.startsWith('scan-'));

    const stats = await store.getFolderStats(`folder-${NODE_ID}-${FOLDER}`);
    assert.ok(stats);
    assert.equal(stats.totalFiles, 3);
  } finally {
    await cleanupTestState(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanner: incremental scan detects modifications', async () => {
  const db = getDb();
  const root = tempDir();
  try {
    writeFileSync(join(root, 'a.txt'), 'original', 'utf-8');

    const store = createFileSyncStore();
    const { scanFolder } = createScanner(store, NODE_ID);

    const r1 = await scanFolder('test-incr', root, 'full');
    assert.equal(r1.totalFiles, 1);

    writeFileSync(join(root, 'a.txt'), 'modified content', 'utf-8');

    const r2 = await scanFolder('test-incr', root, 'incremental');
    assert.equal(r2.totalFiles, 1);
    // At least one change detected (modified or added — depends on mtime resolution)
    assert.ok(r2.modified + r2.added >= 1);
  } finally {
    await cleanupTestState(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanner: detects removed files', async () => {
  const db = getDb();
  const root = tempDir();
  try {
    writeFileSync(join(root, 'keep.txt'), 'keep', 'utf-8');
    writeFileSync(join(root, 'remove.txt'), 'remove', 'utf-8');

    const store = createFileSyncStore();
    const { scanFolder } = createScanner(store, NODE_ID);

    await scanFolder(FOLDER, root, 'full');
    rmSync(join(root, 'remove.txt'));

    const result = await scanFolder(FOLDER, root, 'full');
    assert.equal(result.removed, 1);
    assert.equal(result.totalFiles, 1);
  } finally {
    await cleanupTestState(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanner: skips .git and node_modules', async () => {
  const db = getDb();
  const root = tempDir();
  try {
    writeFileSync(join(root, 'real.txt'), 'data', 'utf-8');
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config'), '[core]', 'utf-8');
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'dep.js'), '//', 'utf-8');

    const store = createFileSyncStore();
    const { scanFolder } = createScanner(store, NODE_ID);
    const result = await scanFolder(FOLDER, root, 'full');

    assert.equal(result.totalFiles, 1);
  } finally {
    await cleanupTestState(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanner: empty directory', async () => {
  const db = getDb();
  const root = tempDir();
  try {
    const store = createFileSyncStore();
    const { scanFolder } = createScanner(store, NODE_ID);
    const result = await scanFolder(FOLDER, root, 'full');

    assert.equal(result.totalFiles, 0);
    assert.equal(result.added, 0);
    assert.equal(result.removed, 0);
  } finally {
    await cleanupTestState(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanner: skips unreadable files gracefully', async () => {
  const db = getDb();
  const root = tempDir();
  try {
    writeFileSync(join(root, 'readable.txt'), 'data', 'utf-8');
    try {
      writeFileSync(join(root, 'noperm.txt'), 'secret', 'utf-8');
      chmodSync(join(root, 'noperm.txt'), 0o000);
    } catch {
      // CI environments may not support chmod 000
    }

    const store = createFileSyncStore();
    const { scanFolder } = createScanner(store, NODE_ID);
    const result = await scanFolder(FOLDER, root, 'full');

    assert.ok(result.totalFiles >= 1);
  } finally {
    try { chmodSync(join(root, 'noperm.txt'), 0o644); } catch {}
    await cleanupTestState(db);
    rmSync(root, { recursive: true, force: true });
  }
});
