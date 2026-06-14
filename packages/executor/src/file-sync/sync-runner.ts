// Sync runner: incremental sync queue following rclonemana's CONTINUOUS_SYNC_DESIGN state machine.
// States: ready → transferring → verifying → done | retry → cooldown | reconcile
import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import { getLogger } from '@los/infra/logger';
import type { FileSyncStore } from './store.js';

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
  const { store, folderId, localPath, nodeId, maxRetries } = options;
  const resolvedRoot = resolve(localPath);

  // Build manifest: compare entries in DB against files on disk
  // Full implementation in follow-up iteration — scaffold for now
  log.info(`sync ${folderId}: ready for incremental sync (root=${resolvedRoot})`);
  return { folderId, processed: 0, succeeded: 0, failed: 0, cooldown: 0, reconcile: 0 };
}
