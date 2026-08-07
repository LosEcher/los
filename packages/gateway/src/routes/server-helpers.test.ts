import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { normalizeBoundedInteger } from './server-helpers.js';

describe('normalizeBoundedInteger', () => {
  it('accepts JSON numbers and numeric strings, clamping to bounds', () => {
    assert.equal(normalizeBoundedInteger(439934, 0, 0, Number.MAX_SAFE_INTEGER), 439934);
    assert.equal(normalizeBoundedInteger('439934', 0, 0, Number.MAX_SAFE_INTEGER), 439934);
    assert.equal(normalizeBoundedInteger(999, 1, 10, 100), 100);
    assert.equal(normalizeBoundedInteger(1, 1, 10, 100), 10);
  });
  it('falls back for missing or non-numeric values', () => {
    assert.equal(normalizeBoundedInteger(undefined, 7, 0, 100), 7);
    assert.equal(normalizeBoundedInteger('abc', 7, 0, 100), 7);
    assert.equal(normalizeBoundedInteger({}, 7, 0, 100), 7);
  });
});
