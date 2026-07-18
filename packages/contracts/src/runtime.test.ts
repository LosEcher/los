import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRunSpecRequest } from './generated/run-spec.js';

test('run-spec runtime validator accepts a valid request', () => {
  const result = validateRunSpecRequest({
    prompt: 'inspect current state',
    provider: null,
    toolMode: 'read-only',
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
    timeoutMs: 0,
  });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.errors.some(error => error.instancePath === '/toolMode'));
    assert.ok(result.errors.some(error => error.instancePath === '/timeoutMs'));
  }
});
