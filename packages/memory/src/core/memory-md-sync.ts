/**
 * MEMORY.md auto-sync — debounced write to workspace root MEMORY.md.
 *
 * Called after each addObservation() to keep MEMORY.md in sync.
 * Fires at most every 60s regardless of call frequency.
 *
 * This module exists in a separate file to keep store.ts under 600 lines.
 */

import { resolve } from 'node:path';

let _mdSyncTimer: ReturnType<typeof setTimeout> | null = null;
const MD_SYNC_DEBOUNCE_MS = 60_000;

export function scheduleMemoryMdSync(): void {
  if (_mdSyncTimer) clearTimeout(_mdSyncTimer);
  _mdSyncTimer = setTimeout(() => {
    // Lazy imports to avoid circular deps (markdown ↔ store)
    import('../markdown.js').then(({ syncMemoryMd }) => {
      import('./store.js').then(({ searchObservations }) => {
        searchObservations('', { limit: 50 }).then(observations => {
          syncMemoryMd(resolve(process.cwd()), observations);
        }).catch(() => { /* fire-and-forget */ });
      });
    }).catch(() => { /* fire-and-forget */ });
  }, MD_SYNC_DEBOUNCE_MS).unref();
}
