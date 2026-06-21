/**
 * GA Loop auto-fix strategies for consistency audit and hotspot detection.
 *
 * Extracted from ga-loop-runner.ts to keep that file under the 400-line
 * warn threshold. Follows the same pattern as ga-scenario-fixes.ts.
 */
import { getLogger } from '@los/infra/logger';

const log = getLogger('ga-loop-runner');

// ── Consistency audit auto-fix ─────────────────────────

export async function applyConsistencyFix(
  summary: Record<string, unknown>,
): Promise<{ applied: boolean; detail: string }> {
  const todoRecon = summary.todoReconciliation as Record<string, unknown> | undefined;
  if (!todoRecon) return { applied: false, detail: 'No todoReconciliation in audit summary' };

  const seedOnly = (todoRecon.seedOnly as number) ?? 0;
  const dbOnly = (todoRecon.dbOnly as number) ?? 0;
  const statusDrift = (todoRecon.statusDrift as number) ?? 0;

  if (seedOnly === 0 && dbOnly === 0 && statusDrift === 0) {
    return { applied: true, detail: 'No drifts to reconcile — already consistent' };
  }

  const fixes: string[] = [];

  // Fix 1: Create missing seed todos in DB
  if (seedOnly > 0) {
    try {
      const { reconcilePlanningTodosFromOpenDb } = await import('./governance-reconciliation.js');
      // Re-run reconciliation to get fresh items
      const report = await reconcilePlanningTodosFromOpenDb({ includeArchived: false });
      for (const item of report.seedOnly) {
        try {
          const LOS_PLANNING_TODO_SEED = (await import('./todo-seeds.js')).LOS_PLANNING_TODO_SEED;
          const seedDef = LOS_PLANNING_TODO_SEED.find(s => s.id === item.id);
          if (seedDef) {
            await (await import('./todos.js')).createTodo({
              ...seedDef,
              source: 'governance_auto_fix',
              metadata: { autoFixed: true, fixedAt: new Date().toISOString(), reason: 'seed-only reconciliation' },
            });
          }
        } catch {
          // individual todo creation failure is non-fatal
        }
      }
      fixes.push(`Created ${seedOnly} missing seed todo(s) in DB`);
    } catch (err) {
      fixes.push(`Failed to create seed-only todos: ${err instanceof Error ? err.message : String(err)}`);
      return { applied: true, detail: fixes.join('; ') };
    }
  }

  // Fix 2: Update status drift (db status → seed status)
  if (statusDrift > 0) {
    try {
      const { reconcilePlanningTodosFromOpenDb } = await import('./governance-reconciliation.js');
      const { updateTodo } = await import('./todos.js');
      const report = await reconcilePlanningTodosFromOpenDb({ includeArchived: false });

      let fixed = 0;
      for (const drift of report.statusDrift) {
        if (!drift.expectedStatus) continue;
        try {
          await updateTodo(drift.id, { status: drift.expectedStatus as any });
          fixed += 1;
        } catch {
          // individual status update failure is non-fatal
        }
      }
      fixes.push(`Resolved ${fixed}/${statusDrift} status drift(s)`);
    } catch (err) {
      fixes.push(`Failed to fix status drifts: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fix 3: dbOnly items — archive them if they have no active children
  if (dbOnly > 0) {
    try {
      const { reconcilePlanningTodosFromOpenDb } = await import('./governance-reconciliation.js');
      const { archiveTodo, loadTodo } = await import('./todos.js');
      const report = await reconcilePlanningTodosFromOpenDb({ includeArchived: false });

      let archived = 0;
      for (const item of report.dbOnly) {
        try {
          const todo = await loadTodo(item.id);
          if (todo && !todo.archivedAt) {
            await archiveTodo(item.id);
            archived += 1;
          }
        } catch {
          // individual archive failure is non-fatal
        }
      }
      if (archived > 0) fixes.push(`Archived ${archived}/${dbOnly} DB-only todo(s)`);
      else fixes.push(`DB-only todos (${dbOnly}) left for manual review — may still be active`);
    } catch (err) {
      fixes.push(`Failed to archive DB-only todos: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { applied: true, detail: fixes.join('; ') };
}

// ── Hotspot auto-fix ───────────────────────────────────

export async function applyHotspotFix(
  summary: Record<string, unknown>,
): Promise<{ applied: boolean; detail: string }> {
  const cleanup = summary.runtimeCleanup as Record<string, unknown> | undefined;
  if (!cleanup) return { applied: false, detail: 'No runtimeCleanup in audit summary' };

  const illegalStatusCount = (cleanup.illegalStatusCount as number) ?? 0;
  const staleFixtureCount = (cleanup.staleFixtureCount as number) ?? 0;

  if (illegalStatusCount === 0 && staleFixtureCount === 0) {
    return { applied: true, detail: 'No hotspot issues detected' };
  }

  const fixes: string[] = [];

  // Fix: Attempt to move illegal status task_runs to blocked
  if (illegalStatusCount > 0) {
    try {
      const { getDb } = await import('@los/infra/db');
      const db = getDb();
      const result = await db.query<{ id: string }>(
        `UPDATE task_runs SET status = 'blocked', updated_at = now()
         WHERE status NOT IN ('pending', 'queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled')
         RETURNING id`,
      );
      const fixed = result.rows.length;
      fixes.push(`Moved ${fixed}/${illegalStatusCount} illegal status task_run(s) to blocked`);
    } catch (err) {
      fixes.push(`Failed to fix illegal statuses: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fix: Attempt to mark stale fixtures as cancelled
  if (staleFixtureCount > 0) {
    try {
      const { getDb } = await import('@los/infra/db');
      const db = getDb();
      const result = await db.query<{ id: string }>(
        `UPDATE task_runs SET status = 'cancelled', updated_at = now()
         WHERE status = 'running' AND metadata_json->>'test_fixture' = 'true'
           AND updated_at < now() - INTERVAL '24 hours'
         RETURNING id`,
      );
      const fixed = result.rows.length;
      fixes.push(`Cancelled ${fixed}/${staleFixtureCount} stale fixture task_run(s)`);
    } catch (err) {
      fixes.push(`Failed to fix stale fixtures: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { applied: true, detail: fixes.join('; ') };
}
