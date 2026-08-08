/**
 * AP12: todo outcome mapping + reconcile write-back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';

import { createTaskRun, ensureTaskRunStore } from './task-runs.js';
import { createTodo, loadTodo, archiveTodo, updateTodo } from './todos.js';
import {
  applyTodoOutcome,
  applyTodoOutcomeFromScheduledEvent,
  reconcileOpenTodosFromOutcomes,
  todoStatusFromFeedAnalysisStatus,
  todoStatusFromScheduledEventType,
  todoStatusFromTaskRunStatus,
} from './todo-outcome-sync.js';

let dbReady = false;
async function initOnce() {
  if (dbReady) return;
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  dbReady = true;
}

const suffix = () => `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

test('todo status mappers cover terminal task, event, and feed-analysis outcomes', () => {
  assert.equal(todoStatusFromTaskRunStatus('succeeded'), 'done');
  assert.equal(todoStatusFromTaskRunStatus('failed'), 'blocked');
  assert.equal(todoStatusFromTaskRunStatus('blocked'), 'blocked');
  assert.equal(todoStatusFromTaskRunStatus('cancelled'), 'cancelled');
  assert.equal(todoStatusFromTaskRunStatus('running'), 'in_progress');
  assert.equal(todoStatusFromTaskRunStatus('unknown'), null);

  assert.equal(todoStatusFromScheduledEventType('task.succeeded'), 'done');
  assert.equal(todoStatusFromScheduledEventType('task.failed'), 'blocked');
  assert.equal(todoStatusFromScheduledEventType('task.blocked'), 'blocked');
  assert.equal(todoStatusFromScheduledEventType('task.cancelled'), 'cancelled');
  assert.equal(todoStatusFromScheduledEventType('task.running'), 'in_progress');
  assert.equal(todoStatusFromScheduledEventType('task.queued'), null);

  assert.equal(todoStatusFromFeedAnalysisStatus('completed'), 'done');
  assert.equal(todoStatusFromFeedAnalysisStatus('failed'), 'blocked');
  assert.equal(todoStatusFromFeedAnalysisStatus('cancelled'), 'cancelled');
  assert.equal(todoStatusFromFeedAnalysisStatus('processing'), 'in_progress');
});

test('applyTodoOutcome writes terminal status and protects completed todos', async () => {
  await initOnce();
  const id = `todo-outcome-${suffix()}`;
  try {
    await createTodo({
      id,
      title: 'outcome apply',
      kind: 'task',
      status: 'in_progress',
      priority: 'P2',
      source: 'todo-outcome-sync.test',
    });
    const applied = await applyTodoOutcome({
      todoId: id,
      targetStatus: 'done',
      taskRunId: `task-${suffix()}`,
      reason: 'unit',
      source: 'manual',
    });
    assert.equal(applied.applied, true);
    assert.equal(applied.todo?.status, 'done');
    assert.equal((applied.todo?.metadata as { outcomeSync?: { source?: string } }).outcomeSync?.source, 'manual');

    const blocked = await applyTodoOutcome({
      todoId: id,
      targetStatus: 'blocked',
      reason: 'should not regress',
      source: 'manual',
    });
    assert.equal(blocked.applied, false);
    assert.equal(blocked.skippedReason, 'terminal_protected');
    assert.equal((await loadTodo(id))?.status, 'done');
  } finally {
    await archiveTodo(id, 'test cleanup').catch(() => undefined);
  }
});

test('reconcileOpenTodosFromOutcomes heals in_progress todos with terminal task_runs', async () => {
  await initOnce();
  await ensureTaskRunStore();
  const s = suffix();
  const todoId = `todo-recon-${s}`;
  const taskRunId = `task-recon-${s}`;
  const sessionId = `session-recon-${s}`;
  try {
    await createTaskRun({
      id: taskRunId,
      sessionId,
      workspaceRoot: process.cwd(),
      toolMode: 'read-only',
      promptPreview: 'reconcile test',
      status: 'succeeded',
    });
    await createTodo({
      id: todoId,
      title: 'zombie in_progress',
      kind: 'task',
      status: 'in_progress',
      priority: 'P2',
      source: 'todo-outcome-sync.test',
      taskRunId,
      sessionId,
    });

    const dry = await reconcileOpenTodosFromOutcomes({ limit: 50, dryRun: true });
    assert.ok(dry.items.some(i => i.todoId === todoId && i.toStatus === 'done'));
    assert.equal((await loadTodo(todoId))?.status, 'in_progress');

    const live = await reconcileOpenTodosFromOutcomes({ limit: 50, dryRun: false });
    assert.ok(live.applied >= 1);
    assert.equal((await loadTodo(todoId))?.status, 'done');
  } finally {
    await archiveTodo(todoId, 'test cleanup').catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE id = $1', [taskRunId]).catch(() => undefined);
  }
});

test('reconcile does not re-close a todo reopened after its run completed', async () => {
  await initOnce();
  await ensureTaskRunStore();
  const s = suffix();
  const todoId = `todo-reopen-${s}`;
  const taskRunId = `task-reopen-${s}`;
  const sessionId = `session-reopen-${s}`;
  try {
    await createTaskRun({
      id: taskRunId,
      sessionId,
      workspaceRoot: process.cwd(),
      toolMode: 'read-only',
      promptPreview: 'reopen test',
      status: 'succeeded',
    });
    // The run finished an hour ago; the todo was manually reopened after it.
    await getDb().query(
      `UPDATE task_runs SET completed_at = now() - interval '1 hour' WHERE id=$1`,
      [taskRunId],
    );
    await createTodo({
      id: todoId,
      title: 'manually reopened',
      kind: 'task',
      status: 'ready',
      priority: 'P2',
      source: 'todo-outcome-sync.test',
      taskRunId,
      sessionId,
    });
    await getDb().query(`UPDATE todos SET reopened_at = now() WHERE id=$1`, [todoId]);

    const dry = await reconcileOpenTodosFromOutcomes({ limit: 50, dryRun: true });
    assert.ok(
      !dry.items.some(i => i.todoId === todoId),
      'stale terminal lineage must not re-close a reopened todo',
    );
    const live = await reconcileOpenTodosFromOutcomes({ limit: 50, dryRun: false });
    assert.equal((await loadTodo(todoId))?.status, 'ready', 'reopened todo must stay open');
  } finally {
    await archiveTodo(todoId, 'test cleanup').catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE id = $1', [taskRunId]).catch(() => undefined);
  }
});

test('reconcile closes a reopened todo when a NEW run completes after the reopen', async () => {
  await initOnce();
  await ensureTaskRunStore();
  const s = suffix();
  const todoId = `todo-reopen-newrun-${s}`;
  const oldRunId = `task-reopen-old-${s}`;
  const newRunId = `task-reopen-new-${s}`;
  const sessionId = `session-reopen-new-${s}`;
  try {
    for (const [id, age] of [[oldRunId, '2 hours'], [newRunId, '10 minutes']] as const) {
      await createTaskRun({
        id,
        sessionId,
        workspaceRoot: process.cwd(),
        toolMode: 'read-only',
        promptPreview: `reopen ${id}`,
        status: 'succeeded',
      });
      await getDb().query(
        `UPDATE task_runs SET completed_at = now() - $1::interval WHERE id=$2`,
        [age, id],
      );
    }
    await createTodo({
      id: todoId,
      title: 'reopened with fresh run',
      kind: 'task',
      status: 'ready',
      priority: 'P2',
      source: 'todo-outcome-sync.test',
      taskRunId: newRunId, // dispatch already re-linked the lineage
      sessionId,
    });
    // Reopen happened between the two runs (after old, before new completed).
    await getDb().query(
      `UPDATE todos SET reopened_at = now() - interval '30 minutes' WHERE id=$1`,
      [todoId],
    );

    const dry = await reconcileOpenTodosFromOutcomes({ limit: 50, dryRun: true });
    const hit = dry.items.find(i => i.todoId === todoId);
    assert.ok(hit && hit.toStatus === 'done',
      'a run completed after the reopen belongs to the new work cycle and must close the todo');
  } finally {
    await archiveTodo(todoId, 'test cleanup').catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE id IN ($1, $2)', [oldRunId, newRunId]).catch(() => undefined);
  }
});

test('applyTodoOutcomeFromScheduledEvent preserves metadata updated during execution', async () => {
  await initOnce();
  const id = `todo-outcome-meta-${suffix()}`;
  try {
    await createTodo({
      id,
      title: 'meta race',
      kind: 'task',
      status: 'in_progress',
      priority: 'P2',
      source: 'todo-outcome-sync.test',
      metadata: { statusReview: 'pending', note: 'base', workspaceRoot: process.cwd() },
    });
    // Execution-time updates: operator annotation lands on the same keys.
    await updateTodo(id, {
      metadata: { statusReview: 'approved', note: 'updated during run', addedDuringRun: 'x' },
    });
    const applied = await applyTodoOutcomeFromScheduledEvent({
      todoId: id,
      eventType: 'task.succeeded',
      taskRunId: `task-${suffix()}`,
      sessionId: `session-${suffix()}`,
      baseMetadata: { statusReview: 'pending', note: 'base', workspaceRoot: process.cwd() },
    });
    assert.equal(applied.applied, true);
    const meta = applied.todo?.metadata as Record<string, unknown>;
    assert.equal(meta.statusReview, 'approved', 'callback must not clobber in-run updates');
    assert.equal(meta.note, 'updated during run');
    assert.equal(meta.addedDuringRun, 'x');
    assert.equal(meta.workspaceRoot, process.cwd(),
      'dispatch-time keys untouched during the run must survive');
    assert.equal(applied.todo?.status, 'done');
  } finally {
    await archiveTodo(id, 'test cleanup').catch(() => undefined);
  }
});

test.after(async () => {
  // package test runner may share process; do not close global pool aggressively
  void closeDb;
});
