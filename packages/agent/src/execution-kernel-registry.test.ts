import assert from 'node:assert/strict';
import test from 'node:test';
import { _createExecutionKernelRegistry } from './execution-kernel-registry.js';

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
