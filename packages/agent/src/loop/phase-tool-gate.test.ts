import test from 'node:test';
import assert from 'node:assert/strict';

import { isToolAllowedInPhase } from './phase-tool-gate.js';

test('planning permits inspection tools and blocks writes', () => {
  assert.equal(isToolAllowedInPhase('read_file', 'planning').allowed, true);
  assert.equal(isToolAllowedInPhase('search_content', 'planning').allowed, true);
  assert.equal(isToolAllowedInPhase('write_file', 'planning').allowed, false);
  assert.equal(isToolAllowedInPhase('run_shell', 'planning').allowed, false);
});

test('verification permits the actual shell tool while terminal phases do not', () => {
  assert.equal(isToolAllowedInPhase('run_shell', 'verifying').allowed, true);
  assert.equal(isToolAllowedInPhase('run_shell', 'succeeded').allowed, false);
});
