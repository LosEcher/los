import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyK4ExecutionKernelRollback,
  createK4ExecutionKernelSelection,
  getLosKernelSelectionIdentity,
  getPiK4KernelSelectionIdentity,
  grantK4CanaryAuthorization,
  normalizeExecutionKernelSelection,
  validateK4ExecutionKernelSelection,
} from './execution-kernel-selection.js';

test('K4 selection binds the exact candidate and keeps canary authorization separate', () => {
  const selection = createK4ExecutionKernelSelection({
    experimentId: 'experiment-k4',
    disposition: 'inspection',
    actor: 'operator:test',
    now: new Date('2026-07-26T00:00:00.000Z'),
  });

  assert.deepEqual(selection.requested, getPiK4KernelSelectionIdentity());
  assert.deepEqual(selection.selected, getPiK4KernelSelectionIdentity());
  assert.deepEqual(selection.rollback.target, getLosKernelSelectionIdentity());
  assert.equal(selection.canaryAuthorization.status, 'not_granted');
  assert.match(validateK4ExecutionKernelSelection(selection, {
    runContractMode: 'audit',
    toolMode: 'read-only',
    requireCanaryAuthorization: true,
  }) ?? '', /authorization is not granted/);

  const authorized = grantK4CanaryAuthorization(selection, 'operator:test', new Date('2026-07-26T00:01:00.000Z'));
  assert.equal(validateK4ExecutionKernelSelection(authorized, {
    runContractMode: 'audit',
    toolMode: 'read-only',
    requireCanaryAuthorization: true,
  }), null);
  assert.deepEqual(normalizeExecutionKernelSelection(authorized), authorized);
});

test('K4 rollback selects LOS, revokes canary consent, and preserves history', () => {
  const selected = grantK4CanaryAuthorization(createK4ExecutionKernelSelection({
    experimentId: 'experiment-k4',
    disposition: 'planning',
    actor: 'operator:select',
  }), 'operator:authorize');
  const rolledBack = applyK4ExecutionKernelRollback(
    selected,
    'operator:rollback',
    'canonical transcript drift',
    new Date('2026-07-26T00:02:00.000Z'),
  );

  assert.deepEqual(rolledBack.selected, getLosKernelSelectionIdentity());
  assert.equal(rolledBack.rollback.status, 'applied');
  assert.equal(rolledBack.canaryAuthorization.status, 'not_granted');
  assert.deepEqual(rolledBack.history.map(entry => entry.action), ['selected', 'rollback']);
  assert.equal(validateK4ExecutionKernelSelection(rolledBack, {
    runContractMode: 'audit',
    toolMode: 'read-only',
    requireCanaryAuthorization: true,
  }), null);
});

test('K4 selection fails closed for write mode or remote execution', () => {
  const selection = createK4ExecutionKernelSelection({
    experimentId: 'experiment-k4',
    disposition: 'inspection',
    actor: 'operator:test',
  });
  assert.match(validateK4ExecutionKernelSelection(selection, {
    runContractMode: 'execution',
    toolMode: 'read-only',
    requireCanaryAuthorization: false,
  }) ?? '', /mode=audit/);
  assert.match(validateK4ExecutionKernelSelection(selection, {
    runContractMode: 'audit',
    toolMode: 'project-write',
    requireCanaryAuthorization: false,
  }) ?? '', /toolMode=read-only/);
  assert.match(validateK4ExecutionKernelSelection(selection, {
    runContractMode: 'audit',
    toolMode: 'read-only',
    executorEnabled: true,
    requireCanaryAuthorization: false,
  }) ?? '', /does not allow remote executor/);
});
