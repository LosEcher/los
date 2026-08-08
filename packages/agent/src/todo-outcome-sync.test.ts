/**
 * AP12: todo outcome mapping + reconcile write-back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';

import { createTaskRun, ensureTaskRunStore } from './task-runs.js';
import { createTodo, loadTodo, archiveTodo } from './todos.js';
import {
  applyTodoOutcome,
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

test.after(async () => {
  // package test runner may share process; do not close global pool aggressively
  void closeDb;
});
