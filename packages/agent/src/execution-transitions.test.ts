import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ExecutionTransitionError,
  assertExecutionTransition,
  canTransitionExecutionState,
  evaluateExecutionTransition,
  executionTransitionEventType,
  isTerminalExecutionState,
} from './execution-transitions.js';

test('execution transitions allow conservative run spec lifecycle moves', () => {
  assert.equal(canTransitionExecutionState('run_spec', 'created', 'running'), true);
  assert.equal(canTransitionExecutionState('run_spec', 'running', 'blocked'), true);
  assert.equal(canTransitionExecutionState('run_spec', 'blocked', 'running'), true);
  assert.equal(canTransitionExecutionState('run_spec', 'running', 'succeeded'), true);

  assert.equal(canTransitionExecutionState('run_spec', 'succeeded', 'running'), false);
  assert.equal(canTransitionExecutionState('run_spec', 'created', 'succeeded'), false);
  assert.equal(isTerminalExecutionState('run_spec', 'cancelled'), true);
});

test('execution transitions allow task runs to move from queued through one terminal state', () => {
  assert.equal(canTransitionExecutionState('task_run', 'queued', 'running'), true);
  assert.equal(canTransitionExecutionState('task_run', 'queued', 'cancelled'), true);
  assert.equal(canTransitionExecutionState('task_run', 'running', 'failed'), true);

  assert.equal(canTransitionExecutionState('task_run', 'failed', 'running'), false);
  assert.equal(canTransitionExecutionState('task_run', 'queued', 'succeeded'), false);
  assert.equal(isTerminalExecutionState('task_run', 'succeeded'), true);
});

test('execution transitions model tool approval, execution, and retry states', () => {
  assert.equal(canTransitionExecutionState('tool_call_state', 'requested', 'approved'), true);
  assert.equal(canTransitionExecutionState('tool_call_state', 'requested', 'running'), true);
  assert.equal(canTransitionExecutionState('tool_call_state', 'approved', 'running'), true);
  assert.equal(canTransitionExecutionState('tool_call_state', 'running', 'failed'), true);
  assert.equal(canTransitionExecutionState('tool_call_state', 'failed', 'retrying'), true);
  assert.equal(canTransitionExecutionState('tool_call_state', 'retrying', 'running'), true);

  assert.equal(canTransitionExecutionState('tool_call_state', 'succeeded', 'retrying'), false);
  assert.equal(canTransitionExecutionState('tool_call_state', 'denied', 'running'), false);
  assert.equal(isTerminalExecutionState('tool_call_state', 'failed'), false);
});

test('execution transitions allow verification reruns after failure', () => {
  assert.equal(canTransitionExecutionState('verification_record', 'required', 'running'), true);
  assert.equal(canTransitionExecutionState('verification_record', 'running', 'succeeded'), true);
  assert.equal(canTransitionExecutionState('verification_record', 'running', 'failed'), true);
  assert.equal(canTransitionExecutionState('verification_record', 'failed', 'running'), true);

  assert.equal(canTransitionExecutionState('verification_record', 'succeeded', 'running'), false);
  assert.equal(canTransitionExecutionState('verification_record', 'required', 'succeeded'), false);
  assert.equal(isTerminalExecutionState('verification_record', 'skipped'), true);
});

test('execution transition evaluation reports idempotent and invalid transitions', () => {
  assert.deepEqual(
    evaluateExecutionTransition({ entityType: 'task_run', from: 'running', to: 'running' }),
    { allowed: true, reason: 'idempotent_transition' },
  );

  assert.throws(
    () => assertExecutionTransition({ entityType: 'task_run', from: 'succeeded', to: 'running' }),
    ExecutionTransitionError,
  );

  assert.equal(executionTransitionEventType('verification_record', 'succeeded'), 'verification_record.succeeded');
});
