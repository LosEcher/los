/**
 * worker-ask-tools tests — verifies the ask_coordinator/escalate tools refuse to
 * block when no taskRunId is threaded (direct runAgent outside a scheduled task).
 *
 * The full block flow (emit message + transition blocked + abort) is DB-backed and
 * covered by the scheduler end-to-end harness; here we only assert the refusal
 * guard, which is pure logic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry } from '../core/registry.js';
import { registerWorkerAskTools } from './worker-ask-tools.js';

test('ask_coordinator refuses to block without a taskRunId', async () => {
  const registry = createToolRegistry();
  registerWorkerAskTools(registry, {}); // no taskRunId — direct runAgent scenario

  const result = await registry.execute({
    name: 'ask_coordinator',
    arguments: { question: 'which branch?' },
  });
  assert.ok(result.error, 'should return an error when no taskRunId is available');
  assert.match(result.error, /scheduled task/i);
});

test('ask_coordinator requires a question', async () => {
  const registry = createToolRegistry();
  registerWorkerAskTools(registry, { taskRunId: 'task-1' });

  const result = await registry.execute({
    name: 'ask_coordinator',
    arguments: { question: '' },
  });
  assert.equal(result.error, 'question is required');
});

test('escalate refuses to block without a taskRunId', async () => {
  const registry = createToolRegistry();
  registerWorkerAskTools(registry, {});

  const result = await registry.execute({
    name: 'escalate',
    arguments: { reason: 'need human' },
  });
  assert.ok(result.error, 'should return an error when no taskRunId is available');
});

test('escalate requires a reason', async () => {
  const registry = createToolRegistry();
  registerWorkerAskTools(registry, { taskRunId: 'task-1' });

  const result = await registry.execute({
    name: 'escalate',
    arguments: { reason: '' },
  });
  assert.equal(result.error, 'reason is required');
});
