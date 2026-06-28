/**
 * Migration-drift TODO creation — extracted helper (mirrors
 * governance-sweeper-branch-todos.ts) to keep governance-sweeper.ts under the
 * 400-line CI gate.
 *
 * Surfaces one operator TODO per drifted table (from the migration-drift
 * baseline audit). A Claude agent works them via /pr-self-merge: rewrite the
 * migration to match ensure*Store, shrink the baseline; the next sweep
 * auto-archives the resolved TODO.
 *
 * CRITICAL: createTodo does NOT upsert on dedupe_key (ON CONFLICT (id) only).
 * A second createTodo with the same dedupe_key THROWS on idx_todos_project_dedupe.
 * This helper does its own lookup → update-or-create, and archives TODOs for
 * tables no longer in the baseline (the resolve闭环).
 */
import type { GovernanceJob } from './governance-jobs-types.js';
import type { ParsedDriftTable } from './governance-auditors-migration.js';
import { createTodo, updateTodo, archiveTodo, unarchiveTodo, listTodos } from './todos.js';
import { getLogger } from '@los/infra/logger';

const log = getLogger('governance-jobs');

const SOURCE = 'governance-migration-drift';
const dedupeKeyFor = (table: string) => `migration-drift-${table}`;

export async function createMigrationDriftTodos(
  job: GovernanceJob,
  summary: Record<string, unknown>,
): Promise<number> {
  try {
    if (summary.fileMissing === true) return 0;
    // If the audit itself errored (wrapper returned {error}), do NOT touch
    // TODOs — an empty tables list would otherwise archive every active
    // drift TODO (false resolve) during a transient audit failure.
    if (typeof summary.error === 'string') return 0;
    const tables = (summary.tables as ParsedDriftTable[] | undefined) ?? [];
    // NOTE: do NOT early-return on empty tables — an empty baseline means all
    // drift was fixed, so we must fall through to archive every existing TODO.

    const currentKeys = new Set(tables.map((t) => dedupeKeyFor(t.table)));

    // List existing migration-drift TODOs INCLUDING archived ones. Archived
    // TODOs retain their dedupe_key, so a naive createTodo after archive would
    // throw on idx_todos_project_dedupe. Instead, reopen+update archived TODOs
    // when their table re-enters the baseline (drift regrew after a fix).
    const existing = await listTodos({ source: SOURCE, limit: 500, includeArchived: true });
    const existingByDedupe = new Map<string, { id: string; dedupeKey: string | null; archived: boolean }>();
    for (const t of existing) {
      if (t.dedupeKey && t.dedupeKey.startsWith('migration-drift-')) {
        existingByDedupe.set(t.dedupeKey, { id: t.id, dedupeKey: t.dedupeKey, archived: t.archivedAt != null });
      }
    }

    let touched = 0;
    for (const t of tables) {
      const dedupeKey = dedupeKeyFor(t.table);
      const title = `migration-drift: align ${t.table} to ensure*Store`;
      const description = [
        `Table ${t.table} has migration-vs-ensure*Store drift (${t.totalDrift} entries:`,
        `${t.columnDrift} cols, ${t.indexDrift} indexes, ${t.constraintDrift} constraints;`,
        `${t.migOnlyCount} mig-only, ${t.ensureOnlyCount} ensure-only).`,
        `Priority ${t.priority}. ensure source: ${t.ensureSource}.`,
        `Fix: rewrite the migration to match ensure*Store, then run`,
        `\`pnpm check:migration-drift --update-baseline\` to shrink the baseline,`,
        `then /pr-self-merge. Next sweep archives this TODO.`,
        ``,
        `Sample drift lines:`,
        ...t.sampleLines.map((l) => `  ${l}`),
      ].join('\n');
      const metadata = {
        table: t.table,
        priority: t.priority,
        driftCounts: {
          columns: t.columnDrift,
          indexes: t.indexDrift,
          constraints: t.constraintDrift,
          functions: t.functionDrift,
          triggers: t.triggerDrift,
          migOnly: t.migOnlyCount,
          ensureOnly: t.ensureOnlyCount,
        },
        ensureSource: t.ensureSource,
        sampleLines: t.sampleLines,
        baselineLineCount: summary.baselineLineCount,
        sweepJobId: job.id,
      };

      const ex = existingByDedupe.get(dedupeKey);
      if (ex) {
        if (ex.archived) await unarchiveTodo(ex.id); // drift regrew after a fix — reopen
        await updateTodo(ex.id, { title, description, status: 'ready', priority: t.priority, metadata });
        existingByDedupe.delete(dedupeKey); // remaining = resolved (no longer in baseline)
      } else {
        await createTodo({
          title,
          description,
          kind: 'task',
          status: 'ready',
          priority: t.priority,
          source: SOURCE,
          dedupeKey,
          metadata,
        });
      }
      touched += 1;
    }

    // Resolve闭环: archive ACTIVE TODOs for tables no longer in the baseline
    // (drift fixed). Archived ones not in the baseline are already resolved —
    // leave them. Only archive active ones to avoid re-archiving.
    for (const { id, dedupeKey, archived } of existingByDedupe.values()) {
      if (!archived && !currentKeys.has(dedupeKey!)) {
        await archiveTodo(id, `migration-drift resolved: ${dedupeKey} no longer in baseline`);
        log.info(`Archived migration-drift TODO ${dedupeKey} (table drift fixed)`);
      }
    }

    return touched;
  } catch (err) {
    log.warn(`createMigrationDriftTodos failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}
