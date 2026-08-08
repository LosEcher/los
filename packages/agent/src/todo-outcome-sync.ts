/**
 * @los/agent/todo-outcome-sync — AP12 single write-back path.
 *
 * Owning integration paths must map terminal task / dispatch outcomes onto
 * the linked todo. This module is the shared mapper + apply + sweep surface so
 * feed-analysis, todo-dispatch, and governance do not invent divergent rules.
 *
 * Mapping policy (fail closed for non-terminal inputs):
 *   task_run succeeded           → todo done
 *   task_run failed | blocked    → todo blocked
 *   task_run cancelled           → todo cancelled
 *   feed-analysis completed      → todo done
 *   feed-analysis failed         → todo blocked
 *   feed-analysis cancelled      → todo cancelled
 *   feed-analysis processing/queued → todo in_progress (optional progress)
 *
 * Sweep: open todos whose linked task_run or feed-analysis dispatch is already
 * terminal are reconciled in a bounded batch (used by self_bootstrap).
 */

import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import type { FeedAnalysisStatus } from './integration/feed-analysis-types.js';
import type { TaskRunStatus } from './task-runs.js';
import { ensureTodoStore, loadTodo, updateTodo, type TodoRecord, type TodoStatus } from './todos.js';

const log = getLogger('todo-outcome-sync');

const TERMINAL_TODO: ReadonlySet<TodoStatus> = new Set(['done', 'cancelled']);

export type TodoOutcomeSource =
  | 'todo-dispatch'
  | 'feed-analysis'
  | 'task-run-reconcile'
  | 'feed-analysis-reconcile'
  | 'manual';

export interface ApplyTodoOutcomeInput {
  todoId: string;
  targetStatus: TodoStatus;
  taskRunId?: string | null;
  sessionId?: string | null;
  reason: string;
  source: TodoOutcomeSource;
  /** Merged over the current todo.metadata (outcome ledger lives under outcomeSync). */
  extraMetadata?: Record<string, unknown>;
  /** When true, allow moving a terminal todo (done/cancelled) to another status. */
  force?: boolean;
}

export interface ApplyTodoOutcomeResult {
  applied: boolean;
  todo: TodoRecord | null;
  skippedReason?: string;
}

export interface TodoOutcomeDriftItem {
  todoId: string;
  title: string;
  fromStatus: TodoStatus;
  toStatus: TodoStatus;
  taskRunId?: string;
  taskRunStatus?: TaskRunStatus;
  feedAnalysisStatus?: FeedAnalysisStatus;
  source: TodoOutcomeSource;
  applied: boolean;
  dryRun: boolean;
}

export interface ReconcileTodoOutcomesReport {
  scanned: number;
  drifted: number;
  applied: number;
  dryRun: boolean;
  items: TodoOutcomeDriftItem[];
}

/** Map durable task_run status → todo status. Non-terminal → null. */
export function todoStatusFromTaskRunStatus(status: TaskRunStatus | string): TodoStatus | null {
  switch (status) {
    case 'succeeded':
      return 'done';
    case 'failed':
    case 'blocked':
      return 'blocked';
    case 'cancelled':
      return 'cancelled';
    case 'running':
    case 'queued':
      return 'in_progress';
    default:
      return null;
  }
}

/** Map scheduler lifecycle event type → todo status. Progress-only → null. */
export function todoStatusFromScheduledEventType(eventType: string): TodoStatus | null {
  switch (eventType) {
    case 'task.succeeded':
      return 'done';
    case 'task.failed':
    case 'task.blocked':
      return 'blocked';
    case 'task.cancelled':
      return 'cancelled';
    case 'task.running':
      return 'in_progress';
    default:
      return null;
  }
}

/** Map feed-analysis dispatch status → todo status. */
export function todoStatusFromFeedAnalysisStatus(status: FeedAnalysisStatus | string): TodoStatus | null {
  switch (status) {
    case 'completed':
    case 'result_ready':
      return 'done';
    case 'failed':
      return 'blocked';
    case 'cancelled':
      return 'cancelled';
    case 'processing':
    case 'queued':
    case 'accepted':
      return 'in_progress';
    default:
      return null;
  }
}

/**
 * Apply a single todo status write-back. Idempotent when already at target.
 * Does not regress terminal todos unless `force` is set.
 */
export async function applyTodoOutcome(input: ApplyTodoOutcomeInput): Promise<ApplyTodoOutcomeResult> {
  await ensureTodoStore();
  const existing = await loadTodo(input.todoId);
  if (!existing) {
    return { applied: false, todo: null, skippedReason: 'not_found' };
  }
  if (existing.archivedAt) {
    return { applied: false, todo: existing, skippedReason: 'archived' };
  }
  if (existing.status === input.targetStatus) {
    // Still refresh lineage ids if provided and missing.
    const needsLineage =
      (input.taskRunId && existing.taskRunId !== input.taskRunId)
      || (input.sessionId && existing.sessionId !== input.sessionId);
    if (!needsLineage) {
      return { applied: false, todo: existing, skippedReason: 'already_target' };
    }
  }
  if (!input.force && TERMINAL_TODO.has(existing.status) && existing.status !== input.targetStatus) {
    return { applied: false, todo: existing, skippedReason: 'terminal_protected' };
  }

  const outcomeSync = {
    source: input.source,
    reason: input.reason,
    targetStatus: input.targetStatus,
    previousStatus: existing.status,
    taskRunId: input.taskRunId ?? existing.taskRunId,
    sessionId: input.sessionId ?? existing.sessionId,
    updatedAt: new Date().toISOString(),
  };

  const updated = await updateTodo(input.todoId, {
    status: input.targetStatus,
    taskRunId: input.taskRunId ?? existing.taskRunId,
    sessionId: input.sessionId ?? existing.sessionId,
    metadata: {
      ...existing.metadata,
      ...input.extraMetadata,
      outcomeSync,
    },
  });

  return { applied: true, todo: updated };
}

/**
 * Convenience for scheduled-task event handlers (todo-dispatch and similar).
 */
export async function applyTodoOutcomeFromScheduledEvent(input: {
  todoId: string;
  eventType: string;
  taskRunId?: string | null;
  sessionId?: string | null;
  source?: TodoOutcomeSource;
  baseMetadata?: Record<string, unknown>;
  lastRun?: Record<string, unknown>;
}): Promise<ApplyTodoOutcomeResult> {
  // Reload the todo at callback time so the dispatch-time metadata snapshot
  // never clobbers updates made during execution (operator annotations,
  // statusReview, etc.). The callback owns lineage/outcome fields only;
  // baseMetadata merely fills keys that no longer exist at callback time.
  const latestTodo = await loadTodo(input.todoId);
  const mergedBase = input.baseMetadata && latestTodo?.metadata
    ? { ...input.baseMetadata, ...latestTodo.metadata }
    : (input.baseMetadata ?? latestTodo?.metadata);
  const target = todoStatusFromScheduledEventType(input.eventType);
  if (!target) {
    // Progress-only: attach lineage without forcing a status change when already in_progress.
    if (input.eventType === 'task.running' || input.taskRunId || input.sessionId) {
      return applyTodoOutcome({
        todoId: input.todoId,
        targetStatus: 'in_progress',
        taskRunId: input.taskRunId,
        sessionId: input.sessionId,
        reason: `scheduler event ${input.eventType}`,
        source: input.source ?? 'todo-dispatch',
        extraMetadata: mergedBase,
      });
    }
    return { applied: false, todo: null, skippedReason: 'non_terminal_event' };
  }

  return applyTodoOutcome({
    todoId: input.todoId,
    targetStatus: target,
    taskRunId: input.taskRunId,
    sessionId: input.sessionId,
    reason: `scheduler event ${input.eventType}`,
    source: input.source ?? 'todo-dispatch',
    extraMetadata: {
      ...mergedBase,
      ...(input.lastRun ? { lastRun: input.lastRun } : {}),
      ...(target === 'blocked' || target === 'cancelled'
        ? { dispatchReady: false }
        : {}),
    },
  });
}

/**
 * Sync a feed-analysis work-item todo from the dispatch record.
 * No-op when workItemId is missing or status has no mapping.
 */
export async function syncTodoFromFeedAnalysisDispatch(input: {
  workItemId?: string | null;
  status: FeedAnalysisStatus | string;
  taskRunId?: string | null;
  sessionId?: string | null;
  dispatchId?: string;
  errorCode?: string;
  errorMessage?: string;
}): Promise<ApplyTodoOutcomeResult> {
  if (!input.workItemId) {
    return { applied: false, todo: null, skippedReason: 'no_work_item' };
  }
  const target = todoStatusFromFeedAnalysisStatus(input.status);
  if (!target) {
    return { applied: false, todo: null, skippedReason: 'unmapped_status' };
  }
  // Only write terminal outcomes from this helper (avoid thrashing on every progress tick).
  // Callers that need in_progress can pass forceProgress.
  if (target === 'in_progress') {
    return applyTodoOutcome({
      todoId: input.workItemId,
      targetStatus: 'in_progress',
      taskRunId: input.taskRunId,
      sessionId: input.sessionId,
      reason: `feed-analysis status ${input.status}`,
      source: 'feed-analysis',
      extraMetadata: input.dispatchId
        ? { feedAnalysis: { dispatchId: input.dispatchId, status: input.status } }
        : undefined,
    });
  }

  return applyTodoOutcome({
    todoId: input.workItemId,
    targetStatus: target,
    taskRunId: input.taskRunId,
    sessionId: input.sessionId,
    reason: `feed-analysis status ${input.status}`,
    source: 'feed-analysis',
    extraMetadata: {
      feedAnalysis: {
        dispatchId: input.dispatchId,
        status: input.status,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
      },
      dispatchReady: target === 'done' ? undefined : false,
    },
  });
}

/**
 * Bounded sweep: open todos whose linked task_run or feed-analysis dispatch is
 * already terminal. When dryRun=false, applies write-back.
 */
export async function reconcileOpenTodosFromOutcomes(
  options: { limit?: number; dryRun?: boolean } = {},
): Promise<ReconcileTodoOutcomesReport> {
  await ensureTodoStore();
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
  const dryRun = options.dryRun === true;
  const items: TodoOutcomeDriftItem[] = [];

  // Path A: todos.task_run_id → terminal task_runs. A todo re-opened after
  // its linked run completed (reopened_at > tr.completed_at) starts a new
  // work cycle — its stale lineage must NOT re-close it. Only runs that
  // completed after the reopen (or todos never reopened) are reconciled.
  const byTaskRun = await getDb().query<{
    todo_id: string;
    title: string;
    todo_status: TodoStatus;
    task_run_id: string;
    task_status: TaskRunStatus;
    session_id: string | null;
  }>(
    `SELECT t.id AS todo_id, t.title, t.status AS todo_status,
            tr.id AS task_run_id, tr.status AS task_status, tr.session_id
     FROM todos t
     INNER JOIN task_runs tr ON tr.id = t.task_run_id
     WHERE t.archived_at IS NULL
       AND t.status IN ('ready', 'in_progress', 'backlog')
       AND tr.status IN ('succeeded', 'failed', 'cancelled', 'blocked')
       AND (t.reopened_at IS NULL
            OR (tr.completed_at IS NOT NULL AND t.reopened_at < tr.completed_at))
     ORDER BY t.updated_at ASC
     LIMIT $1`,
    [limit],
  );

  for (const row of byTaskRun.rows) {
    const toStatus = todoStatusFromTaskRunStatus(row.task_status);
    if (!toStatus || toStatus === 'in_progress') continue;
    if (row.todo_status === toStatus) continue;
    items.push({
      todoId: row.todo_id,
      title: row.title,
      fromStatus: row.todo_status,
      toStatus,
      taskRunId: row.task_run_id,
      taskRunStatus: row.task_status,
      source: 'task-run-reconcile',
      applied: false,
      dryRun,
    });
  }

  // Path B: feed-analysis work items whose dispatch is terminal
  try {
    const remaining = Math.max(0, limit - items.length);
    if (remaining > 0) {
      const byFeed = await getDb().query<{
        todo_id: string;
        title: string;
        todo_status: TodoStatus;
        fa_status: FeedAnalysisStatus;
        task_run_id: string | null;
        session_id: string | null;
        dispatch_id: string;
      }>(
        `SELECT t.id AS todo_id, t.title, t.status AS todo_status,
                d.status AS fa_status, d.task_run_id, d.session_id, d.id AS dispatch_id
         FROM todos t
         INNER JOIN feed_analysis_dispatches d ON d.work_item_id = t.id
         WHERE t.archived_at IS NULL
           AND t.status IN ('ready', 'in_progress', 'backlog')
           AND d.status IN ('completed', 'failed', 'cancelled', 'result_ready')
           AND (t.reopened_at IS NULL
                OR (d.completed_at IS NOT NULL AND t.reopened_at < d.completed_at))
         ORDER BY t.updated_at ASC
         LIMIT $1`,
        [remaining],
      );
      const seen = new Set(items.map(i => i.todoId));
      for (const row of byFeed.rows) {
        if (seen.has(row.todo_id)) continue;
        const toStatus = todoStatusFromFeedAnalysisStatus(row.fa_status);
        if (!toStatus || toStatus === 'in_progress') continue;
        if (row.todo_status === toStatus) continue;
        items.push({
          todoId: row.todo_id,
          title: row.title,
          fromStatus: row.todo_status,
          toStatus,
          taskRunId: row.task_run_id ?? undefined,
          feedAnalysisStatus: row.fa_status,
          source: 'feed-analysis-reconcile',
          applied: false,
          dryRun,
        });
        seen.add(row.todo_id);
      }
    }
  } catch (err) {
    // feed_analysis tables may not exist in minimal test schemas.
    log.debug(`feed-analysis reconcile skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  let applied = 0;
  if (!dryRun) {
    for (const item of items) {
      const result = await applyTodoOutcome({
        todoId: item.todoId,
        targetStatus: item.toStatus,
        taskRunId: item.taskRunId,
        reason: `reconcile from ${item.source}`,
        source: item.source,
      }).catch((err) => {
        log.warn('todo outcome reconcile apply failed', {
          todoId: item.todoId,
          error: err instanceof Error ? err.message : String(err),
        });
        return { applied: false, todo: null, skippedReason: 'apply_error' } as ApplyTodoOutcomeResult;
      });
      item.applied = result.applied;
      if (result.applied) applied += 1;
    }
  }

  return {
    scanned: byTaskRun.rows.length + items.filter(i => i.source === 'feed-analysis-reconcile').length,
    drifted: items.length,
    applied,
    dryRun,
    items,
  };
}
