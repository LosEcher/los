import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('systemd unit leaves executor endpoint configuration to the node env file', () => {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const unit = readFileSync(`${repoRoot}deploy/systemd/los-executor.service`, 'utf8');

  assert.match(unit, /^EnvironmentFile=\/opt\/los\/\.env$/m);
  assert.doesNotMatch(unit, /^Environment=EXECUTOR_(?:HOST|PORT)=/m);
  assert.match(unit, /^#   EXECUTOR_HOST=/m);
  assert.match(unit, /^#   EXECUTOR_PORT=/m);
});
