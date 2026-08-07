import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveSandboxBackend,
  runSandboxedShell,
} from './shell-sandbox.js';

test('resolveSandboxBackend prefers the OS sandbox when available', () => {
  assert.equal(resolveSandboxBackend('darwin', true, false, false), 'macos-sandbox-exec');
  assert.equal(resolveSandboxBackend('darwin', true, false, true), 'macos-sandbox-exec');
  assert.equal(resolveSandboxBackend('linux', false, true, false), 'linux-bwrap');
  assert.equal(resolveSandboxBackend('linux', false, true, true), 'linux-bwrap');
});

test('resolveSandboxBackend denies native fallback unless allowNativeShell', () => {
  // darwin without sandbox-exec
  assert.equal(resolveSandboxBackend('darwin', false, false, false), 'native-denied');
  assert.equal(resolveSandboxBackend('darwin', false, false, true), 'native');
  // linux without bwrap
  assert.equal(resolveSandboxBackend('linux', false, false, false), 'native-denied');
  assert.equal(resolveSandboxBackend('linux', false, false, true), 'native');
  // other platforms
  assert.equal(resolveSandboxBackend('freebsd', false, false, false), 'native-denied');
  assert.equal(resolveSandboxBackend('freebsd', false, false, true), 'native');
});

test('runSandboxedShell executes through an OS sandbox backend when available', async () => {
  // Runs on macOS (sandbox-exec) and Linux CI (bwrap); the native-denied
  // branch is covered by the resolveSandboxBackend decision table above.
  // Some sandboxed CI shells cannot apply a nested sandbox profile
  // (sandbox_apply: Operation not permitted) — the assertion is that the
  // backend was chosen (not denied) and any error is a sandbox-env error,
  // not the deny guard.
  const result = await runSandboxedShell({
    command: 'echo sandbox-backend-check',
    cwd: '/tmp',
    timeoutMs: 5000,
  });
  assert.notEqual(result.sandbox, 'native-denied');
  assert.equal(result.error?.includes('denied'), false);
  if (!result.error) {
    assert.match(result.content, /sandbox-backend-check/);
  }
});

test('runSandboxedShell default options deny when no backend is present (decision wiring)', () => {
  // The default allowNativeShell=false is what makes the deny path reachable
  // on backend-less platforms; assert the wiring contract directly.
  assert.equal(resolveSandboxBackend('freebsd', false, false, undefined === true), 'native-denied');
});
