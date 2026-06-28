/**
 * File-size TODO creation — second self-iteration detector (mirrors
 * governance-sweeper-migration-todos.ts). Converts the file_size GA job from a
 * degenerate report-only autoFix (which never reduced file sizes) into a
 * detection-driven TODO worklist: one TODO per >400-line file, worked by a
 * Claude agent via /pr-self-merge (extract submodule → file shrinks → TODO
 * auto-archives on next sweep).
 *
 * CRITICAL: createTodo does NOT upsert on dedupe_key (ON CONFLICT (id) only).
 * This helper does its own lookup → update-or-create (with reopen for archived),
 * and archives TODOs for files no longer over threshold (resolve闭环).
 */
import type { GovernanceJob } from './governance-jobs-types.js';
import { createTodo, updateTodo, archiveTodo, unarchiveTodo, listTodos } from './todos.js';
import { getLogger } from '@los/infra/logger';

const log = getLogger('governance-jobs');
const SOURCE = 'governance-file-size';
const dedupeKeyFor = (file: string) => `file-size-${file.replace(/[^a-z0-9_-]/gi, '_')}`;

interface HotFileEntry { file: string; lines: number; package?: string; delta?: number; }

export async function createFileSizeTodos(
  job: GovernanceJob,
  summary: Record<string, unknown>,
): Promise<number> {
  try {
    if (typeof summary.error === 'string') return 0;
    const over600 = (summary.filesOver600 as HotFileEntry[] | undefined) ?? [];
    const over400 = (summary.filesOver400 as HotFileEntry[] | undefined) ?? [];
    // Surface all >400-line files: P1 for >600, P2 for 400-600.
    const all = new Map<string, HotFileEntry & { priority: 'P1' | 'P2' }>();
    for (const f of over400) all.set(f.file, { ...f, priority: 'P2' });
    for (const f of over600) all.set(f.file, { ...f, priority: 'P1' }); // 600+ overrides → P1
    if (all.size === 0) return 0;

    const currentKeys = new Set([...all.keys()].map(dedupeKeyFor));

    const existing = await listTodos({ source: SOURCE, limit: 500, includeArchived: true });
    const existingByDedupe = new Map<string, { id: string; dedupeKey: string | null; archived: boolean }>();
    for (const t of existing) {
      if (t.dedupeKey && t.dedupeKey.startsWith('file-size-')) {
        existingByDedupe.set(t.dedupeKey, { id: t.id, dedupeKey: t.dedupeKey, archived: t.archivedAt != null });
      }
    }

    let touched = 0;
    for (const [file, f] of all) {
      const dedupeKey = dedupeKeyFor(file);
      const title = `file-size: extract submodule from ${file} (${f.lines} lines)`;
      const description = [
        `${file} is ${f.lines} lines (threshold 400${f.priority === 'P1' ? ', >600 P1' : ''}).`,
        `Package: ${f.package ?? '?'}. Delta vs last scan: ${f.delta ?? 'n/a'}.`,
        `Fix: extract a cohesive submodule (see check-structure.sh thresholds),`,
        `then /pr-self-merge. Next sweep archives this TODO when the file < 400 lines.`,
      ].join('\n');
      const metadata = {
        file, lines: f.lines, package: f.package, delta: f.delta,
        priority: f.priority, threshold: 400, sweepJobId: job.id,
      };
      const ex = existingByDedupe.get(dedupeKey);
      if (ex) {
        if (ex.archived) await unarchiveTodo(ex.id); // file regrew past threshold after a fix
        await updateTodo(ex.id, { title, description, status: 'ready', priority: f.priority, metadata });
        existingByDedupe.delete(dedupeKey);
      } else {
        await createTodo({ title, description, kind: 'task', status: 'ready', priority: f.priority, source: SOURCE, dedupeKey, metadata });
      }
      touched += 1;
    }

    // Resolve闭环: archive active TODOs for files no longer over threshold (refactored down).
    for (const { id, dedupeKey, archived } of existingByDedupe.values()) {
      if (!archived && !currentKeys.has(dedupeKey!)) {
        await archiveTodo(id, `file-size resolved: ${dedupeKey} now under 400 lines`);
        log.info(`Archived file-size TODO ${dedupeKey} (file shrunk under threshold)`);
      }
    }
    return touched;
  } catch (err) {
    log.warn(`createFileSizeTodos failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}
