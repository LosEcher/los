import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutorRuntimeLifecycle } from './runtime-lifecycle.js';

test('executor lifecycle rejects new tasks while draining and resolves when active work finishes', async () => {
  const lifecycle = new ExecutorRuntimeLifecycle();
  const task = lifecycle.startTask();
  assert.ok(task);
  assert.equal(lifecycle.activeTaskCount, 1);

  lifecycle.beginDrain();
  assert.equal(lifecycle.status, 'draining');
  assert.equal(lifecycle.startTask(), null);

  const idle = lifecycle.waitForIdle(1_000);
  task.finish();
  assert.equal(await idle, true);
  assert.equal(lifecycle.activeTaskCount, 0);
});

test('executor lifecycle aborts active tasks after the shutdown grace expires', async () => {
  const lifecycle = new ExecutorRuntimeLifecycle();
  const task = lifecycle.startTask();
  assert.ok(task);

  lifecycle.beginDrain();
  assert.equal(await lifecycle.waitForIdle(1), false);

  const reason = new Error('shutdown grace expired');
  lifecycle.abortAll(reason);
  assert.equal(task.controller.signal.aborted, true);
  assert.equal(task.controller.signal.reason, reason);

  task.finish();
  lifecycle.markOffline();
  assert.equal(lifecycle.status, 'offline');
});
