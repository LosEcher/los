import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _listRefreshBackoffMs,
  _selectSchedulablePeriodicFolders,
  PERIODIC_LIST_REFRESH_BASE_MS,
  PERIODIC_LIST_REFRESH_MAX_MS,
} from './periodic.js';
import type { FileSyncFolder } from './store.js';

function folder(input: Partial<FileSyncFolder> & {
  folderId: string;
  name: string;
  localPath: string;
}): FileSyncFolder {
  return {
    folderId: input.folderId,
    name: input.name,
    localPath: input.localPath,
    status: input.status ?? 'active',
    scanIntervalSec: input.scanIntervalSec ?? 1800,
    settleWindowSec: input.settleWindowSec ?? 60,
    nodeId: input.nodeId ?? 'test-node',
    createdAt: input.createdAt ?? new Date(0).toISOString(),
    updatedAt: input.updatedAt ?? new Date(0).toISOString(),
    lastScanAt: input.lastScanAt,
    lastScanDurationMs: input.lastScanDurationMs,
  };
}

test('periodic scheduling folds nested active folders into parent timer', () => {
  const selected = _selectSchedulablePeriodicFolders([
    folder({ folderId: 'projects', name: 'projects', localPath: '/workspace/projects' }),
    folder({ folderId: 'root', name: 'root', localPath: '/workspace' }),
    folder({ folderId: 'other', name: 'other', localPath: '/other' }),
  ]);

  assert.deepEqual(selected.map(f => f.folderId), ['other', 'root']);
});

test('periodic scheduling ignores inactive folders and duplicate paths', () => {
  const selected = _selectSchedulablePeriodicFolders([
    folder({ folderId: 'archived', name: 'archived', localPath: '/workspace/old', status: 'archived' }),
    folder({ folderId: 'dupe-b', name: 'dupe-b', localPath: '/workspace' }),
    folder({ folderId: 'dupe-a', name: 'dupe-a', localPath: '/workspace/.' }),
  ]);

  assert.deepEqual(selected.map(f => f.folderId), ['dupe-a']);
});

test('list refresh backoff grows exponentially and caps to avoid PG request storms', () => {
  assert.equal(_listRefreshBackoffMs(0), PERIODIC_LIST_REFRESH_BASE_MS);
  assert.equal(_listRefreshBackoffMs(1), 120_000);
  assert.equal(_listRefreshBackoffMs(2), 240_000);
  assert.equal(_listRefreshBackoffMs(3), 480_000);
  assert.equal(_listRefreshBackoffMs(4), PERIODIC_LIST_REFRESH_MAX_MS);
  assert.equal(_listRefreshBackoffMs(10), PERIODIC_LIST_REFRESH_MAX_MS);
});
