import test from 'node:test';
import assert from 'node:assert/strict';

import { executionModeForExecutor } from './execution-mode.js';

test('stateless executor maps to the stateless approval channel', () => {
  assert.equal(executionModeForExecutor(true), 'stateless');
});

test('DB-mode executor maps to the interactive channel', () => {
  assert.equal(executionModeForExecutor(false), 'interactive');
});
