// Periodic: executor-side timed scan + sync runner trigger.
// Manages per-folder timers that fire based on scan_interval_sec.
import { getLogger } from '@los/infra/logger';
import { createFileSyncStore } from './store.js';
import { createScanner } from './scanner.js';
import { runSyncQueue } from './sync-runner.js';

const log = getLogger('file-sync-periodic');

export function startPeriodicSync(nodeId: string): () => void {
  const store = createFileSyncStore();
  const scanner = createScanner(store, nodeId);
  const activeTimers = new Map<string, ReturnType<typeof setInterval>>();
  let listRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  async function refreshAndSchedule() {
    if (stopped) return;
    try {
      const folders = await store.listFolders(nodeId);
      const currentIds = new Set(folders.map(f => f.folderId));

      // Start timers for new folders
      for (const folder of folders) {
        if (folder.status !== 'active') continue;
        if (activeTimers.has(folder.folderId)) continue;

        const intervalMs = (folder.scanIntervalSec ?? 1800) * 1000;
        const settleMs = (folder.settleWindowSec ?? 900) * 1000;

        // Fire an initial scan on first discovery (staggered to avoid thundering herd)
        setTimeout(() => {
          if (stopped) return;
          runSyncCycle(store, scanner, folder.name, folder.localPath, folder.folderId, nodeId, settleMs);
        }, Math.random() * 30_000);

        const timer = setInterval(() => {
          if (stopped) return;
          runSyncCycle(store, scanner, folder.name, folder.localPath, folder.folderId, nodeId, settleMs);
        }, intervalMs);

        activeTimers.set(folder.folderId, timer);
        log.info(`periodic sync started for folder ${folder.name} (${folder.folderId}), interval=${intervalMs}ms`);
      }

      // Stop timers for removed/inactive folders
      for (const [id, timer] of activeTimers) {
        if (!currentIds.has(id)) {
          clearInterval(timer);
          activeTimers.delete(id);
          log.info(`periodic sync stopped for removed folder ${id}`);
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
    for (const timer of activeTimers.values()) clearInterval(timer);
    activeTimers.clear();
    log.info('periodic sync stopped');
  };
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
