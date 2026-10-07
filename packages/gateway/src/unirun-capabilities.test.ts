import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  _resetUnirunProbe,
  normalizeUnirunProbe,
  probeUnirun,
  resolveUnirunBinary,
  unirunSshUsable,
  wantsRemoteContext,
  type UnirunCapabilities,
  type UnirunProbeRunner,
} from './unirun-capabilities.js';

const FULL_CAPS: UnirunCapabilities = { sshIdentity: true, sshWorkdirEnv: true };
const NO_CAPS: UnirunCapabilities = { sshIdentity: false, sshWorkdirEnv: false };

/** The document `unirun capabilities --json` prints (schema 1), trimmed to the
 *  keys the gateway reads plus one it does not. */
function capabilitiesJson(...features: string[]): string {
  return JSON.stringify({
    unirun: { version: '0.5.0', schema: 1 },
    platform: { os: 'linux', arch: 'x86_64' },
    features,
  });
}

/** A runner that answers everything the same way (no binary on disk needed). */
function staticRunner(reply: { code: number; stdout: string } | null): UnirunProbeRunner {
  return async () => reply;
}

/** A temp dir with one fake candidate binary inside (existence is all the probe
 *  checks before handing it to the runner). */
function withFakeBinary(t: { after(fn: () => void): void }, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'unirun-caps-'));
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\n');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path;
}

// ── capabilities document parsing ──────────────────────────────────────────

test('probe: a binary that describes itself yields the keys it advertises', async (t) => {
  _resetUnirunProbe();
  const bin = withFakeBinary(t, 'unirun');
  const probe = await probeUnirun(
    { LOS_UNIRUN_BIN: bin },
    staticRunner({ code: 0, stdout: capabilitiesJson('ssh', 'ssh-identity', 'ssh-workdir-env') }),
  );
  assert.equal(probe.bin, bin);
  assert.equal(probe.staleVersion, null);
  assert.deepEqual(probe.capabilities, FULL_CAPS);
});

test('probe: unknown keys are ignored, missing keys stay unsupported', async (t) => {
  _resetUnirunProbe();
  const bin = withFakeBinary(t, 'unirun');
  const probe = await probeUnirun(
    { LOS_UNIRUN_BIN: bin },
    staticRunner({ code: 0, stdout: capabilitiesJson('ssh', 'winrm', 'teleport') }),
  );
  assert.deepEqual(probe.capabilities, NO_CAPS);
});

test('probe: an unreadable capabilities document is conservative', async (t) => {
  const bin = withFakeBinary(t, 'unirun');
  const unreadable = [
    'not json at all',
    '',
    '[]',
    'null',
    '{"unirun":{"version":"0.5.0","schema":1}}', // no features array
    '{"features":"ssh-identity"}', // wrong type
  ];
  for (const stdout of unreadable) {
    _resetUnirunProbe();
    const probe = await probeUnirun({ LOS_UNIRUN_BIN: bin }, staticRunner({ code: 0, stdout }));
    assert.equal(probe.bin, bin, `bin kept for ${JSON.stringify(stdout)}`);
    assert.deepEqual(probe.capabilities, NO_CAPS, `conservative for ${JSON.stringify(stdout)}`);
  }
});

// ── stale binaries (the 0.3.0 case C4/F1) ─────────────────────────────────

test('probe: a binary without `capabilities` is named, not reported as absent', async (t) => {
  _resetUnirunProbe();
  const bin = withFakeBinary(t, 'unirun');
  const runner: UnirunProbeRunner = async (_bin, args) =>
    args[0] === 'capabilities'
      ? { code: 2, stdout: '' } // pre-0.5.0: unknown subcommand
      : { code: 0, stdout: 'unirun 0.3.0\n' };
  const probe = await probeUnirun({ LOS_UNIRUN_BIN: bin }, runner);
  assert.equal(probe.bin, bin);
  assert.equal(probe.staleVersion, 'unirun 0.3.0');
  assert.deepEqual(probe.capabilities, NO_CAPS);
});

test('probe: a stale candidate does not shadow a usable one later in the order', async (t) => {
  _resetUnirunProbe();
  const stale = withFakeBinary(t, 'unirun-old');
  const runner: UnirunProbeRunner = async (bin, args) => {
    if (bin === stale) {
      return args[0] === 'capabilities' ? { code: 2, stdout: '' } : { code: 0, stdout: 'unirun 0.3.0\n' };
    }
    return { code: 0, stdout: capabilitiesJson('ssh', 'ssh-identity', 'ssh-workdir-env') };
  };
  const probe = await probeUnirun({ LOS_UNIRUN_BIN: stale }, runner);
  assert.notEqual(probe.bin, stale);
  assert.equal(probe.staleVersion, null);
  assert.deepEqual(probe.capabilities, FULL_CAPS);
});

test('probe: nothing runnable → absent, with no version to name', async () => {
  _resetUnirunProbe();
  const probe = await probeUnirun({ LOS_UNIRUN_BIN: '/nonexistent/unirun' }, staticRunner(null));
  assert.deepEqual(probe, { bin: null, staleVersion: null, capabilities: NO_CAPS });
});

test('probe: a binary that cannot even report a version is still named', async (t) => {
  _resetUnirunProbe();
  const bin = withFakeBinary(t, 'unirun');
  const runner: UnirunProbeRunner = async () => ({ code: 2, stdout: '' });
  const probe = await probeUnirun({ LOS_UNIRUN_BIN: bin }, runner);
  assert.equal(probe.bin, bin);
  assert.equal(probe.staleVersion, 'unreported version');
});

test('probe: the result is cached, and resolveUnirunBinary agrees with it', async (t) => {
  _resetUnirunProbe();
  const bin = withFakeBinary(t, 'unirun');
  let calls = 0;
  const runner: UnirunProbeRunner = async () => {
    calls += 1;
    return { code: 0, stdout: capabilitiesJson('ssh-identity', 'ssh-workdir-env') };
  };
  const first = await probeUnirun({ LOS_UNIRUN_BIN: bin }, runner);
  const second = await probeUnirun({ LOS_UNIRUN_BIN: bin }, runner);
  assert.equal(calls, 1);
  assert.deepEqual(second, first);
  assert.equal(await resolveUnirunBinary({ LOS_UNIRUN_BIN: bin }), bin);
});

// ── injected seam shapes ───────────────────────────────────────────────────

test('normalizeUnirunProbe: boolean shorthand maps to full/none', () => {
  assert.deepEqual(normalizeUnirunProbe(true).capabilities, FULL_CAPS);
  assert.deepEqual(normalizeUnirunProbe(false).capabilities, NO_CAPS);
});

test('normalizeUnirunProbe: capability sets fill in the conservative fields', () => {
  assert.deepEqual(normalizeUnirunProbe({ sshIdentity: true, sshWorkdirEnv: false }), {
    bin: null,
    staleVersion: null,
    capabilities: { sshIdentity: true, sshWorkdirEnv: false },
  });
  assert.deepEqual(
    normalizeUnirunProbe({ bin: '/usr/local/bin/unirun', staleVersion: 'unirun 0.3.0', capabilities: FULL_CAPS }),
    { bin: '/usr/local/bin/unirun', staleVersion: 'unirun 0.3.0', capabilities: FULL_CAPS },
  );
});

// ── ssh usability gate ─────────────────────────────────────────────────────

test('unirunSshUsable: only a capable-enough binary serves the call', () => {
  const legacy = { sshIdentity: true, sshWorkdirEnv: false };
  assert.equal(unirunSshUsable(FULL_CAPS, {}), true);
  assert.equal(unirunSshUsable(FULL_CAPS, { cwd: '/tmp' }), true);
  assert.equal(unirunSshUsable(FULL_CAPS, { env: { A: '1' } }), true);
  assert.equal(unirunSshUsable(FULL_CAPS, { env: {} }), true);
  assert.equal(unirunSshUsable(legacy, {}), true);
  assert.equal(unirunSshUsable(legacy, { cwd: '/tmp' }), false);
  assert.equal(unirunSshUsable(legacy, { env: { A: '1' } }), false);
  assert.equal(unirunSshUsable(NO_CAPS, {}), false);
});

test('wantsRemoteContext: cwd or any env entry counts', () => {
  assert.equal(wantsRemoteContext({}), false);
  assert.equal(wantsRemoteContext({ env: {} }), false);
  assert.equal(wantsRemoteContext({ cwd: '/tmp' }), true);
  assert.equal(wantsRemoteContext({ env: { A: '1' } }), true);
});

// ── installer / gate agreement ─────────────────────────────────────────────

test('install-unirun.sh requires exactly the keys the gate needs', async (t) => {
  // tools/install-unirun.sh refuses to install a binary that does not report
  // REQUIRED_FEATURES. If that list drifts from what this module reads, an
  // install can pass while the gateway still falls back to native ssh — the
  // "installed but silently unusable" shape of audit C4/F1.
  const script = readFileSync(new URL('../../../tools/install-unirun.sh', import.meta.url), 'utf8');
  const match = /^REQUIRED_FEATURES="([^"]*)"$/m.exec(script);
  assert.ok(match, 'tools/install-unirun.sh must declare REQUIRED_FEATURES');
  const required = match[1].split(/\s+/).filter(Boolean);
  assert.deepEqual([...required].sort(), ['ssh-identity', 'ssh-workdir-env']);

  // Necessary: a remote cwd/env call needs every required key.
  for (const key of required) {
    _resetUnirunProbe();
    const bin = withFakeBinary(t, `unirun-${key}`);
    const advertised = required.filter((candidate) => candidate !== key);
    const probe = await probeUnirun(
      { LOS_UNIRUN_BIN: bin },
      staticRunner({ code: 0, stdout: capabilitiesJson(...advertised) }),
    );
    assert.equal(
      unirunSshUsable(probe.capabilities, { cwd: '/tmp', env: { A: '1' } }),
      false,
      `dropping '${key}' must make the call unusable`,
    );
  }

  // Sufficient: the full set serves it.
  _resetUnirunProbe();
  const bin = withFakeBinary(t, 'unirun-full');
  const probe = await probeUnirun(
    { LOS_UNIRUN_BIN: bin },
    staticRunner({ code: 0, stdout: capabilitiesJson(...required) }),
  );
  assert.equal(unirunSshUsable(probe.capabilities, { cwd: '/tmp', env: { A: '1' } }), true);
});
