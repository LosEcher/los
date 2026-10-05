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
import {
  normalizeUnirunCapabilities,
  parseUnirunCapabilities,
  unirunSshUsable,
  type UnirunCapabilities,
} from './unirun-capabilities.js';

function nodeWith(ssh: Record<string, unknown> = {}) {
  return {
    nodeId: 'node-1',
    connectConfig: { ssh },
  };
}

const FULL_CAPS: UnirunCapabilities = { sshIdentity: true, sshWorkdirEnv: true };

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
    detectUnirun: async () => FULL_CAPS,
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

test('detectUnirun: boolean shorthand true means fully capable', async () => {
  const deps = depsWith({ detectUnirun: async () => true });
  await runSshCommand(nodeWith({ host_name: 'h' }), { command: 'id', cwd: '/tmp' }, deps);
  assert.equal(deps.calls.unirun.length, 1);
  assert.equal(deps.calls.native, 0);
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

test('cwd/env present → unirun path with forwarded options', async () => {
  const deps = depsWith();
  await runSshCommand(nodeWith({ host_name: 'h' }), { command: 'id', cwd: '/tmp' }, deps);
  assert.equal(deps.calls.unirun.length, 1);
  assert.equal(deps.calls.native, 0);
  assert.deepEqual(deps.calls.unirun[0].slice(-2), ['--timeout', '30']);
  assert.ok(deps.calls.unirun[0].includes('--workdir'));
  const deps2 = depsWith();
  await runSshCommand(nodeWith({ host_name: 'h' }), { command: 'id', env: { A: '1' } }, deps2);
  assert.equal(deps2.calls.unirun.length, 1);
  assert.equal(deps2.calls.native, 0);
  assert.ok(deps2.calls.unirun[0].includes('--env'));
});

test('cwd/env + unirun without remote-context support → native path (no flag mangling)', async () => {
  const legacy: UnirunCapabilities = { sshIdentity: true, sshWorkdirEnv: false };
  const deps = depsWith({ detectUnirun: async () => legacy });
  await runSshCommand(nodeWith({ host_name: 'h' }), { command: 'id', cwd: '/tmp' }, deps);
  assert.equal(deps.calls.unirun.length, 0);
  assert.equal(deps.calls.native, 1);

  const deps2 = depsWith({ detectUnirun: async () => legacy });
  await runSshCommand(nodeWith({ host_name: 'h' }), { command: 'id', env: { A: '1' } }, deps2);
  assert.equal(deps2.calls.unirun.length, 0);
  assert.equal(deps2.calls.native, 1);
});

test('unirun without ssh identity flags → native path even without cwd/env', async () => {
  const ancient: UnirunCapabilities = { sshIdentity: false, sshWorkdirEnv: false };
  const deps = depsWith({ detectUnirun: async () => ancient });
  await runSshCommand(nodeWith({ host_name: 'h', user: 'root' }), { command: 'id' }, deps);
  assert.equal(deps.calls.unirun.length, 0);
  assert.equal(deps.calls.native, 1);
});

test('explicit unirun mode + legacy binary → native path (never hand it unknown flags)', async () => {
  const prev = process.env.LOS_SSH_RUNNER;
  process.env.LOS_SSH_RUNNER = 'unirun';
  try {
    const ancient: UnirunCapabilities = { sshIdentity: false, sshWorkdirEnv: false };
    const deps = depsWith({ detectUnirun: async () => ancient });
    await runSshCommand(nodeWith({ host_name: 'h' }), { command: 'id' }, deps);
    assert.equal(deps.calls.unirun.length, 0);
    assert.equal(deps.calls.native, 1);
  } finally {
    if (prev === undefined) delete process.env.LOS_SSH_RUNNER;
    else process.env.LOS_SSH_RUNNER = prev;
  }
});

test('missing host_name → connected=false, no unirun call', async () => {
  const deps = depsWith();
  const result = await runSshCommand(nodeWith({}), { command: 'id' }, deps);
  assert.equal(deps.calls.unirun.length, 0);
  assert.equal(deps.calls.native, 0);
  assert.equal(result.connected, false);
  assert.match(result.error ?? '', /missing connectConfig\.ssh\.host_name/);
});

// ── capabilities ───────────────────────────────────────────────────────────

test('parseUnirunCapabilities: floors at 0.3.0 (identity flags) and 0.4.0 (remote workdir/env)', () => {
  assert.deepEqual(parseUnirunCapabilities('unirun 0.4.0'), FULL_CAPS);
  assert.deepEqual(parseUnirunCapabilities('unirun 0.5.1\n'), FULL_CAPS);
  assert.deepEqual(parseUnirunCapabilities('unirun 1.0.0-rc.1'), FULL_CAPS);
  assert.deepEqual(parseUnirunCapabilities('unirun 0.3.0'), { sshIdentity: true, sshWorkdirEnv: false });
  assert.deepEqual(parseUnirunCapabilities('unirun 0.2.1'), { sshIdentity: false, sshWorkdirEnv: false });
  assert.deepEqual(parseUnirunCapabilities(''), { sshIdentity: false, sshWorkdirEnv: false });
  assert.deepEqual(parseUnirunCapabilities('not a version'), { sshIdentity: false, sshWorkdirEnv: false });
});

test('normalizeUnirunCapabilities: boolean shorthand maps to full/none', () => {
  assert.deepEqual(normalizeUnirunCapabilities(true), FULL_CAPS);
  assert.deepEqual(normalizeUnirunCapabilities(false), {
    sshIdentity: false,
    sshWorkdirEnv: false,
  });
  assert.deepEqual(
    normalizeUnirunCapabilities({ sshIdentity: true, sshWorkdirEnv: false }),
    { sshIdentity: true, sshWorkdirEnv: false },
  );
});

test('unirunSshUsable: only a capable-enough binary serves the call', () => {
  const legacy = { sshIdentity: true, sshWorkdirEnv: false };
  const ancient = { sshIdentity: false, sshWorkdirEnv: false };
  assert.equal(unirunSshUsable(FULL_CAPS, {}), true);
  assert.equal(unirunSshUsable(FULL_CAPS, { cwd: '/tmp' }), true);
  assert.equal(unirunSshUsable(FULL_CAPS, { env: { A: '1' } }), true);
  assert.equal(unirunSshUsable(FULL_CAPS, { env: {} }), true);
  assert.equal(unirunSshUsable(legacy, {}), true);
  assert.equal(unirunSshUsable(legacy, { cwd: '/tmp' }), false);
  assert.equal(unirunSshUsable(legacy, { env: { A: '1' } }), false);
  assert.equal(unirunSshUsable(ancient, {}), false);
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

test('buildUnirunArgs: cwd/env become --workdir/--env flags before --timeout', () => {
  const args = _buildUnirunArgs(
    nodeWith({ host_name: 'h' }),
    { command: 'pwd', cwd: '/srv/a b', env: { A: 'one', B: 'x=y' } },
  );
  assert.deepEqual(args.slice(-8), [
    '--workdir', '/srv/a b', '--env', 'A=one', '--env', 'B=x=y', '--timeout', '30',
  ]);
});

test('buildUnirunArgs: no cwd/env → no workdir/env flags', () => {
  const args = _buildUnirunArgs(nodeWith({ host_name: 'h' }), { command: 'x' });
  assert.equal(args.includes('--workdir'), false);
  assert.equal(args.includes('--env'), false);
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
