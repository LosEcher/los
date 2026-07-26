import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRunSpecRequest } from './generated/run-spec.js';

test('run-spec runtime validator accepts a valid request', () => {
  const result = validateRunSpecRequest({
    prompt: 'inspect current state',
    provider: null,
    toolMode: 'read-only',
    planningTransport: 'typed_tool',
    maxLoops: 2,
  });
  assert.equal(result.success, true);
});

test('run-spec runtime validator accepts an explicit ordered provider fallback policy', () => {
  const result = validateRunSpecRequest({
    prompt: 'inspect the workspace',
    providerFallback: {
      mode: 'explicit_ordered',
      targets: [
        { provider: 'deepseek', model: 'deepseek-v4-flash' },
        { provider: 'xai', model: 'grok-4.3' },
      ],
      onFailure: ['transport', 'rate_limit', 'provider_unavailable'],
      requireCompatibilityEvidence: true,
      maxSwitches: 1,
    },
  });

  assert.equal(result.success, true);
});

test('run-spec runtime validator rejects implicit or single-target fallback', () => {
  const result = validateRunSpecRequest({
    prompt: 'inspect the workspace',
    providerFallback: {
      mode: 'automatic',
      targets: [{ provider: 'deepseek' }],
    },
  });

  assert.equal(result.success, false);
});

test('run-spec runtime validator rejects invalid request fields', () => {
  const result = validateRunSpecRequest({
    prompt: 'inspect current state',
    toolMode: 'root',
    planningTransport: 'markdown',
    timeoutMs: 0,
  });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.errors.some(error => error.instancePath === '/toolMode'));
    assert.ok(result.errors.some(error => error.instancePath === '/planningTransport'));
    assert.ok(result.errors.some(error => error.instancePath === '/timeoutMs'));
  }
});

test('run-spec runtime validator enforces explicit kernel selection evidence shape', () => {
  const identity = { kind: 'pi', version: '0.81.1+los.3', protocolVersion: '0.1.0' };
  const rollback = { kind: 'los', version: '0.1.0', protocolVersion: '0.1.0' };
  const valid = validateRunSpecRequest({
    prompt: 'inspect with the K4 candidate',
    toolMode: 'read-only',
    runContract: {
      mode: 'audit',
      executionKernel: {
        selectionMode: 'explicit',
        experimentId: 'experiment-k4',
        disposition: 'inspection',
        requested: identity,
        selected: identity,
        rollback: { target: rollback, status: 'available' },
        canaryAuthorization: { status: 'not_granted' },
        history: [{ action: 'selected', from: rollback, to: identity, actor: 'operator:test', at: '2026-07-26T00:00:00.000Z' }],
      },
    },
  });
  assert.equal(valid.success, true);

  const invalid = validateRunSpecRequest({
    prompt: 'inspect with an incomplete candidate',
    runContract: {
      executionKernel: {
        selectionMode: 'explicit',
        experimentId: 'experiment-k4',
        disposition: 'inspection',
        requested: identity,
        selected: identity,
        rollback: { target: rollback, status: 'available' },
        canaryAuthorization: { status: 'not_granted' },
        history: [],
      },
    },
  });
  assert.equal(invalid.success, false);
});
