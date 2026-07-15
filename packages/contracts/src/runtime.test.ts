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
