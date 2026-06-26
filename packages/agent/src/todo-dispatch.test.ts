/**
 * Tests for dispatchTodo core function — gate validation paths.
 *
 * Covers the gates that run *before* runScheduledAgentTask fires
 * (not_found / status / kind / dep). The success path is exercised
 * end-to-end in the smoke dispatch verification, since it requires a
 * working provider/agent loop.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';

import { dispatchTodo, DispatchError } from './todo-dispatch.js';
import { createTodo, archiveTodo, type CreateTodoInput } from './todos.js';

let dbInitialized = false;

async function initOnce() {
  if (dbInitialized) return;
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  dbInitialized = true;
}

const suffix = () => `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

function makeTodo(overrides: Partial<CreateTodoInput>): CreateTodoInput {
  const s = suffix();
  return {
    id: `td-test-${s}`,
    title: `dispatch-test-${s}`,
    kind: 'task',
    status: 'ready',
    priority: 'P2',
    source: 'todo-dispatch.test',
    ...overrides,
  };
}

async function cleanup(ids: string[]) {
  for (const id of ids) {
    try { await archiveTodo(id, 'test cleanup'); } catch { /* best effort */ }
  }
}

test('dispatchTodo throws 404 DispatchError for missing todo', async () => {
  await initOnce();
  await assert.rejects(
    () => dispatchTodo(`does-not-exist-${suffix()}`),
    (err: unknown) => err instanceof DispatchError && err.status === 404 && err.code === 'not_found',
  );
});

test('dispatchTodo throws 400 todo_not_ready when status is done', async () => {
  await initOnce();
  const t = await createTodo(makeTodo({ status: 'done' }));
  try {
    await assert.rejects(
      () => dispatchTodo(t.id),
      (err: unknown) => err instanceof DispatchError && err.status === 400 && err.code === 'todo_not_ready',
    );
  } finally {
    await cleanup([t.id]);
  }
});

test('dispatchTodo throws 400 todo_not_dispatchable when kind is plan', async () => {
  await initOnce();
  const t = await createTodo(makeTodo({ kind: 'plan', status: 'ready' }));
  try {
    await assert.rejects(
      () => dispatchTodo(t.id),
      (err: unknown) => err instanceof DispatchError && err.status === 400 && err.code === 'todo_not_dispatchable',
    );
  } finally {
    await cleanup([t.id]);
  }
});

test('dispatchTodo throws 400 todo_dependencies_not_met with incompleteIds', async () => {
  await initOnce();
  const dep = await createTodo(makeTodo({ status: 'in_progress' }));
  const t = await createTodo(makeTodo({ dependsOnIds: [dep.id] }));
  try {
    await assert.rejects(
      () => dispatchTodo(t.id),
      (err: unknown) => {
        if (!(err instanceof DispatchError) || err.status !== 400 || err.code !== 'todo_dependencies_not_met') return false;
        assert.ok(err.detail && Array.isArray((err.detail as { incompleteIds: string[] }).incompleteIds));
        assert.deepEqual((err.detail as { incompleteIds: string[] }).incompleteIds, [dep.id]);
        return true;
      },
    );
  } finally {
    await cleanup([t.id, dep.id]);
  }
});

test('DispatchError carries status/code/detail', () => {
  const e = new DispatchError(400, 'todo_not_ready', 'msg', { incompleteIds: ['x'] });
  assert.equal(e.status, 400);
  assert.equal(e.code, 'todo_not_ready');
  assert.equal(e.name, 'DispatchError');
  assert.deepEqual(e.detail, { incompleteIds: ['x'] });
});

// Close DB after the suite so other suites can re-init cleanly.
test('teardown', async () => {
  if (dbInitialized) await closeDb();
});
