// Periodic: executor-side timed scan + sync runner trigger.
// Manages per-folder timers that fire based on scan_interval_sec.
import { isAbsolute, relative, resolve } from 'node:path';
import { getLogger } from '@los/infra/logger';
import { createFileSyncStore } from './store.js';
import type { FileSyncFolder } from './store.js';
import { createScanner } from './scanner.js';
import { runSyncQueue } from './sync-runner.js';

const log = getLogger('file-sync-periodic');

export function startPeriodicSync(nodeId: string): () => void {
  const store = createFileSyncStore();
  const scanner = createScanner(store, nodeId);
  const activeTimers = new Map<string, {
    interval: ReturnType<typeof setInterval>;
    initial: ReturnType<typeof setTimeout>;
  }>();
  let listRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  async function refreshAndSchedule() {
    if (stopped) return;
    try {
      const folders = await store.listFolders(nodeId);
      const schedulableFolders = _selectSchedulablePeriodicFolders(folders);
      const desiredIds = new Set(schedulableFolders.map(f => f.folderId));
      const activeFolderCount = folders.filter(f => f.status === 'active').length;
      const skippedOverlapCount = activeFolderCount - schedulableFolders.length;
      if (skippedOverlapCount > 0) {
        log.debug(`periodic sync skipped ${skippedOverlapCount} nested active folder(s) already covered by a parent folder`);
      }

      // Start timers for new folders
      for (const folder of schedulableFolders) {
        if (activeTimers.has(folder.folderId)) continue;

        const intervalMs = (folder.scanIntervalSec ?? 1800) * 1000;
        const settleMs = (folder.settleWindowSec ?? 60) * 1000;

        // Fire an initial scan on first discovery (staggered to avoid thundering herd)
        const initial = setTimeout(() => {
          if (stopped) return;
          runSyncCycle(store, scanner, folder.name, folder.localPath, folder.folderId, nodeId, settleMs);
        }, Math.random() * 30_000);

        const timer = setInterval(() => {
          if (stopped) return;
          runSyncCycle(store, scanner, folder.name, folder.localPath, folder.folderId, nodeId, settleMs);
        }, intervalMs);

        activeTimers.set(folder.folderId, { interval: timer, initial });
        log.info(`periodic sync started for folder ${folder.name} (${folder.folderId}), interval=${intervalMs}ms`);
      }

      // Stop timers for removed, inactive, or parent-covered folders
      for (const [id, timers] of activeTimers) {
        if (!desiredIds.has(id)) {
          clearInterval(timers.interval);
          clearTimeout(timers.initial);
          activeTimers.delete(id);
          log.info(`periodic sync stopped for unscheduled folder ${id}`);
        }
      }
    } catch (err) {
      log.warn(`periodic sync refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Initial refresh
  refreshAndSchedule().catch(() => {});
  // Re-list folders every 60s to pick up new registrations
  listRefreshTimer = setInterval(() => refreshAndSchedule(), 60_000);

  return () => {
    stopped = true;
    if (listRefreshTimer) clearInterval(listRefreshTimer);
    for (const timers of activeTimers.values()) {
      clearInterval(timers.interval);
      clearTimeout(timers.initial);
    }
    activeTimers.clear();
    log.info('periodic sync stopped');
  };
}

export function _selectSchedulablePeriodicFolders(folders: FileSyncFolder[]): FileSyncFolder[] {
  const selected: Array<{ folder: FileSyncFolder; normalizedPath: string }> = [];
  const activeFolders = folders
    .filter(folder => folder.status === 'active')
    .map(folder => ({ folder, normalizedPath: normalizeLocalPath(folder.localPath) }))
    .sort((a, b) => {
      const byDepth = pathDepth(a.normalizedPath) - pathDepth(b.normalizedPath);
      if (byDepth !== 0) return byDepth;
      const byPath = a.normalizedPath.localeCompare(b.normalizedPath);
      if (byPath !== 0) return byPath;
      return a.folder.folderId.localeCompare(b.folder.folderId);
    });

  for (const entry of activeFolders) {
    if (selected.some(parent => isSameOrDescendant(parent.normalizedPath, entry.normalizedPath))) {
      continue;
    }
    selected.push(entry);
  }

  return selected.map(entry => entry.folder);
}

function normalizeLocalPath(localPath: string): string {
  return resolve(localPath);
}

function pathDepth(localPath: string): number {
  return localPath.split('/').filter(Boolean).length;
}

function isSameOrDescendant(parentPath: string, candidatePath: string): boolean {
  const childRelativePath = relative(parentPath, candidatePath);
  return childRelativePath === '' || (!childRelativePath.startsWith('..') && !isAbsolute(childRelativePath));
}

async function runSyncCycle(
  store: ReturnType<typeof createFileSyncStore>,
  scanner: ReturnType<typeof createScanner>,
  folderName: string,
  localPath: string,
  folderId: string,
  nodeId: string,
  settleMs: number,
): Promise<void> {
  try {
    const scanResult = await scanner.scanFolder(folderName, localPath, 'incremental');
    if (scanResult.added > 0 || scanResult.modified > 0 || scanResult.removed > 0) {
      log.debug(`periodic scan ${folderName}: +${scanResult.added} ~${scanResult.modified} -${scanResult.removed}, running sync`);
      await runSyncQueue({
        store,
        folderId,
        localPath: scanResult.localPath,
        nodeId,
        maxConcurrency: 1,
        settleWindowMs: settleMs,
        maxRetries: 3,
      });
    }
  } catch (err) {
    log.warn(`periodic sync cycle failed for ${folderName}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
