import assert from 'node:assert/strict';
import test from 'node:test';
import { _createExecutionKernelRegistry, resolveExecutionKernelForRun } from './execution-kernel-registry.js';
import {
  applyK4ExecutionKernelRollback,
  createK4ExecutionKernelSelection,
  grantK4CanaryAuthorization,
} from './execution-kernel-selection.js';

test('execution kernel registry resolves LOS as the explicit default', () => {
  const registry = _createExecutionKernelRegistry();

  assert.equal(registry.resolve().identity.kind, 'los');
  assert.equal(registry.resolve('los').identity.protocolVersion, '0.1.0');
  assert.deepEqual(registry.list().map(kernel => kernel.kind), ['los']);
});

test('execution kernel registry fails closed for unavailable adapters', () => {
  const registry = _createExecutionKernelRegistry();

  assert.throws(() => registry.resolve('pi'), /Unknown execution kernel: pi/);
});

test('execution kernel registry rejects duplicate adapter kinds', () => {
  const duplicate = {
    identity: { kind: 'fixture', version: '1', protocolVersion: '0.1.0' },
    run: async () => ({ text: '', turns: [], loopCount: 0, totalTokens: { prompt: 0, completion: 0 }, messages: [] }),
  };

  assert.throws(() => _createExecutionKernelRegistry([duplicate, duplicate]), /must be unique/);
});

test('per-run resolver admits only an authorized persisted Pi K4 selection', () => {
  const selected = createK4ExecutionKernelSelection({
    experimentId: 'experiment-k4',
    disposition: 'inspection',
    actor: 'operator:test',
  });
  const contract = {
    mode: 'audit' as const,
    editableSurfaces: [],
    requiredChecks: [],
    allowedSkippedChecks: [],
    stopConditions: [],
    evidenceRequired: [],
    externalEvidenceAllowed: [],
    rawEvidenceProhibited: [],
    executionKernel: selected,
  };
  assert.throws(() => resolveExecutionKernelForRun({
    runSpecId: 'run-k4', runContract: contract, toolMode: 'read-only',
  }), /authorization is not granted/);

  const authorized = { ...contract, executionKernel: grantK4CanaryAuthorization(selected, 'operator:test') };
  assert.equal(resolveExecutionKernelForRun({
    runSpecId: 'run-k4', runContract: authorized, toolMode: 'read-only',
  }).identity.kind, 'pi');
  assert.throws(() => resolveExecutionKernelForRun({
    runSpecId: 'run-k4', runContract: authorized, toolMode: 'read-only', executorEnabled: true,
  }), /does not allow remote executor/);

  const rolledBack = { ...contract, executionKernel: applyK4ExecutionKernelRollback(authorized.executionKernel, 'operator:test', 'rollback') };
  assert.equal(resolveExecutionKernelForRun({
    runSpecId: 'run-k4', runContract: rolledBack, toolMode: 'read-only',
  }).identity.kind, 'los');
});
