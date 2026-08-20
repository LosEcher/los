import test from 'node:test';
import assert from 'node:assert/strict';

import {
  _buildUnirunArgs,
  _mapExecResult,
  _resolveSshRunnerMode,
  _runSshNative,
  _sshTransportError,
  runSshCommand,
  type SshRunnerDeps,
} from './ssh-command-runner.js';

function nodeWith(ssh: Record<string, unknown> = {}) {
  return {
    nodeId: 'node-1',
    connectConfig: { ssh },
  };
}

const okResult = {
  exit_code: 0,
  signal: null,
  stdout: 'ok\n',
  stderr: '',
  timed_out: false,
  aborted: false,
  error_class: null,
  hint: null,
};

function depsWith(overrides: Partial<SshRunnerDeps> = {}): SshRunnerDeps & {
  calls: { unirun: string[][]; native: number };
} {
  const calls = { unirun: [] as string[][], native: 0 };
  return {
    detectUnirun: async () => true,
    runUnirun: async (args) => {
      calls.unirun.push(args);
      return { code: 0, stdout: JSON.stringify(okResult), stderr: '' };
    },
    runNative: async () => {
      calls.native += 1;
      return { stdout: '', stderr: '', exitCode: 0, signal: null, connected: true };
    },
    ...overrides,
    calls,
  } as SshRunnerDeps & { calls: { unirun: string[][]; native: number } };
}

// ── mode resolution ────────────────────────────────────────────────────────

test('resolveSshRunnerMode: default auto, explicit overrides', () => {
  assert.equal(_resolveSshRunnerMode({}), 'auto');
  assert.equal(_resolveSshRunnerMode({ LOS_SSH_RUNNER: 'unirun' }), 'unirun');
  assert.equal(_resolveSshRunnerMode({ LOS_SSH_RUNNER: 'native' }), 'native');
  assert.equal(_resolveSshRunnerMode({ LOS_SSH_RUNNER: 'AUTO' }), 'auto');
  assert.equal(_resolveSshRunnerMode({ LOS_SSH_RUNNER: 'garbage' }), 'auto');
});

// ── dispatch ───────────────────────────────────────────────────────────────

test('auto + unirun available → unirun path', async () => {
  const deps = depsWith();
  const result = await runSshCommand(nodeWith({ host_name: 'h' }), { command: 'id' }, deps);
  assert.equal(deps.calls.unirun.length, 1);
  assert.equal(deps.calls.native, 0);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'ok\n');
  assert.equal(result.connected, true);
});

test('auto + unirun missing → native path', async () => {
  const deps = depsWith({ detectUnirun: async () => false });
  const result = await runSshCommand(nodeWith(), { command: 'id' }, deps);
  assert.equal(deps.calls.unirun.length, 0);
  assert.equal(deps.calls.native, 1);
  assert.equal(result.connected, true);
});

test('native mode → native path even when unirun available', async () => {
  const prev = process.env.LOS_SSH_RUNNER;
  process.env.LOS_SSH_RUNNER = 'native';
  try {
    const deps = depsWith();
    await runSshCommand(nodeWith(), { command: 'id' }, deps);
    assert.equal(deps.calls.unirun.length, 0);
    assert.equal(deps.calls.native, 1);
  } finally {
    if (prev === undefined) delete process.env.LOS_SSH_RUNNER;
    else process.env.LOS_SSH_RUNNER = prev;
  }
});

test('unirun throws → fallback to native', async () => {
  const deps = depsWith({
    runUnirun: async () => {
      throw new Error('unirun ssh exited 2: boom');
    },
  });
  const result = await runSshCommand(nodeWith({ host_name: 'h' }), { command: 'id' }, deps);
  assert.equal(deps.calls.native, 1);
  assert.equal(result.connected, true);
});

test('unirun non-zero code → fallback to native', async () => {
  const deps = depsWith({
    runUnirun: async () => ({ code: 2, stdout: '', stderr: 'usage error' }),
  });
  await runSshCommand(nodeWith({ host_name: 'h' }), { command: 'id' }, deps);
  assert.equal(deps.calls.native, 1);
});

test('invalid JSON from unirun → fallback to native', async () => {
  const deps = depsWith({
    runUnirun: async () => ({ code: 0, stdout: 'not-json', stderr: '' }),
  });
  await runSshCommand(nodeWith({ host_name: 'h' }), { command: 'id' }, deps);
  assert.equal(deps.calls.native, 1);
});

test('cwd/env present → native path (unirun ssh lacks remote cwd/env)', async () => {
  const deps = depsWith();
  await runSshCommand(nodeWith(), { command: 'id', cwd: '/tmp' }, deps);
  assert.equal(deps.calls.unirun.length, 0);
  assert.equal(deps.calls.native, 1);
  const deps2 = depsWith();
  await runSshCommand(nodeWith(), { command: 'id', env: { A: '1' } }, deps2);
  assert.equal(deps2.calls.unirun.length, 0);
  assert.equal(deps2.calls.native, 1);
});

test('missing host_name → connected=false, no unirun call', async () => {
  const deps = depsWith();
  const result = await runSshCommand(nodeWith({}), { command: 'id' }, deps);
  assert.equal(deps.calls.unirun.length, 0);
  assert.equal(deps.calls.native, 0);
  assert.equal(result.connected, false);
  assert.match(result.error ?? '', /missing connectConfig\.ssh\.host_name/);
});

// ── arg construction ───────────────────────────────────────────────────────

test('buildUnirunArgs: identity options and timeout', () => {
  const args = _buildUnirunArgs(
    nodeWith({ host_name: '10.0.0.1', user: 'root', port: 2222, identity_file: '/k' }),
    { command: 'ls -la', timeoutMs: 45_000 },
  );
  assert.deepEqual(args, [
    'ssh', '10.0.0.1', 'ls -la', '--json', '--shell', 'bash',
    '--user', 'root', '--port', '2222', '--identity', '/k', '--timeout', '45',
  ]);
});

test('buildUnirunArgs: default shell bash, powershell override, min timeout 1s', () => {
  assert.equal(_buildUnirunArgs(nodeWith({ host_name: 'h' }), { command: 'x' })[5], 'bash');
  const ps = _buildUnirunArgs(
    nodeWith({ host_name: 'h', shell: 'powershell' }),
    { command: 'x' },
  );
  assert.equal(ps[5], 'powershell');
  const tiny = _buildUnirunArgs(nodeWith({ host_name: 'h' }), { command: 'x', timeoutMs: 100 });
  assert.equal(tiny[tiny.length - 1], '1');
});

// ── result mapping ─────────────────────────────────────────────────────────

test('mapExecResult: success passthrough', () => {
  const r = _mapExecResult(okResult, { command: 'x' });
  assert.deepEqual(r, {
    stdout: 'ok\n',
    stderr: '',
    exitCode: 0,
    signal: null,
    connected: true,
  });
});

test('mapExecResult: remote command failure stays connected', () => {
  const r = _mapExecResult(
    { ...okResult, exit_code: 42, stdout: '', error_class: null },
    { command: 'x' },
  );
  assert.equal(r.exitCode, 42);
  assert.equal(r.connected, true);
});

test('mapExecResult: exit 255 → transport error', () => {
  const r = _mapExecResult(
    { ...okResult, exit_code: 255, stderr: 'ssh: connect to host 1.2.3.4 port 22: Connection refused' },
    { command: 'x' },
  );
  assert.equal(r.connected, false);
  assert.match(r.error ?? '', /Connection refused/);
});

test('mapExecResult: command-not-found class stays connected', () => {
  const r = _mapExecResult(
    { ...okResult, exit_code: 127, stderr: 'bash: line 1: nope: command not found', error_class: 'COMMAND_NOT_FOUND' },
    { command: 'x' },
  );
  assert.equal(r.connected, true);
  assert.equal(r.exitCode, 127);
});

test('sshTransportError patterns', () => {
  assert.equal(_sshTransportError(255, ''), 'ssh transport error (exit 255)');
  assert.match(_sshTransportError(null, 'Could not resolve hostname: nope') ?? '', /resolve/i);
  assert.match(_sshTransportError(null, 'Connection timed out') ?? '', /timed out/i);
  assert.match(_sshTransportError(null, 'Permission denied (publickey)') ?? '', /permission/i);
  assert.equal(_sshTransportError(1, 'some remote error'), undefined);
  assert.equal(_sshTransportError(null, ''), undefined);
});

// ── native path (regression guard for the pre-unirun implementation) ──────

test('runSshNative: missing host → connected=false', async () => {
  const result = await _runSshNative(nodeWith({}), { command: 'id' });
  assert.equal(result.connected, false);
  assert.match(result.error ?? '', /missing connectConfig\.ssh\.host_name/);
});
