/**
 * GA Loop auto-fix strategies for consistency audit and hotspot detection.
 *
 * Extracted from ga-loop-runner.ts to keep that file under the 400-line
 * warn threshold. Follows the same pattern as ga-scenario-fixes.ts.
 */
import { getLogger } from '@los/infra/logger';
import { requeueDeadLetterEvent, type DeadLetterRequeueResult } from './dead-letter-recovery.js';
import { reconcilePlanningTodosFromOpenDb } from './governance-reconciliation.js';
import { loadTodo, seedLosPlanningTodos, unarchiveTodo, updateTodo } from './todos.js';

const log = getLogger('ga-loop-runner');

type DeadLetterRequeue = (eventId: string) => Promise<DeadLetterRequeueResult>;

export async function applyDeadLetterFix(
  summary: Record<string, unknown>,
  requeue: DeadLetterRequeue = requeueDeadLetterEvent,
): Promise<{ applied: boolean; detail: string }> {
  const candidateIds = Array.isArray(summary.candidateIds)
    ? summary.candidateIds.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : [];
  if (candidateIds.length === 0) {
    return { applied: false, detail: 'No eligible dead-letter events to requeue' };
  }

  const requeuedTaskRunIds: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];
  for (const eventId of candidateIds) {
    try {
      const result = await requeue(eventId);
      if (result.status === 'requeued') requeuedTaskRunIds.push(result.taskRunId);
      else skipped.push(`${eventId}:${result.reason}`);
    } catch (error) {
      errors.push(`${eventId}:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    applied: requeuedTaskRunIds.length > 0,
    detail: [
      `Requeued ${requeuedTaskRunIds.length}/${candidateIds.length} eligible dead-letter event(s)`,
      ...(skipped.length > 0 ? [`skipped=${skipped.join(',')}`] : []),
      ...(errors.length > 0 ? [`errors=${errors.join(',')}`] : []),
    ].join('; '),
  };
}

// ── Consistency audit auto-fix ─────────────────────────

export async function applyConsistencyFix(
  summary: Record<string, unknown>,
): Promise<{ applied: boolean; detail: string }> {
  const todoRecon = summary.todoReconciliation as Record<string, unknown> | undefined;
  if (!todoRecon) return { applied: false, detail: 'No todoReconciliation in audit summary' };

  const seedOnly = (todoRecon.seedOnly as number) ?? 0;
  const dbOnly = (todoRecon.dbOnly as number) ?? 0;
  const statusDrift = (todoRecon.statusDrift as number) ?? 0;

  if (seedOnly === 0 && statusDrift === 0) {
    return { applied: true, detail: 'No drifts to reconcile — already consistent' };
  }

  const fixes: string[] = [];

  // Fix 1: Create missing seed todos in DB
  if (seedOnly > 0) {
    try {
      const before = await reconcilePlanningTodosFromOpenDb({ includeArchived: false });
      let restored = 0;
      for (const item of before.seedOnly) {
        const existing = await loadTodo(item.id);
        if (existing?.archivedAt) {
          await unarchiveTodo(item.id);
          restored += 1;
        }
      }

      await seedLosPlanningTodos({ overwrite: false });
      const after = await reconcilePlanningTodosFromOpenDb({ includeArchived: false });
      const created = Math.max(0, seedOnly - restored - after.seedOnly.length);
      if (restored > 0) fixes.push(`Restored ${restored} archived seed todo(s)`);
      if (created > 0) fixes.push(`Created ${created} missing seed todo(s) in DB`);
      if (after.seedOnly.length > 0) {
        fixes.push(`${after.seedOnly.length} seed todo(s) remain missing`);
        return { applied: false, detail: fixes.join('; ') };
      }
    } catch (err) {
      fixes.push(`Failed to create seed-only todos: ${err instanceof Error ? err.message : String(err)}`);
      return { applied: false, detail: fixes.join('; ') };
    }
  }

  // Fix 2: Update status drift (db status → seed status)
  if (statusDrift > 0) {
    try {
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

  // DB-only todos may be owned by runtime governance, operators, or external
  // ingestion. Seed reconciliation must never archive them implicitly.
  if (dbOnly > 0) {
    fixes.push(`Preserved ${dbOnly} DB-only todo(s) with independent ownership`);
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
