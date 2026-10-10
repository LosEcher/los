/**
 * process-identity unit tests (control-plane truth remediation §1).
 *
 * Negative control that matters most: a process started without `LOS_VERSION`
 * must report `versionSource: 'package_json'` and a version that is **not** a
 * content hash. The audit's failure mode was exactly this value being read as
 * "the process content hash".
 *
 * Run: node --test src/process-identity.test.ts (or via gateway test-runner)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  _buildProcessIdentityForTests,
  getProcessIdentity,
  _resetProcessIdentityForTests,
} from './process-identity.js';

// ── identity resolution: the three inputs (test-only export) ───────────────────────────────────

test('env version wins and is labelled env', () => {
  const id = _buildProcessIdentityForTests({ envVersion: '0.1.0+bdeadbeef000', packageVersion: '0.1.0' });
  assert.equal(id.processVersion, '0.1.0+bdeadbeef000');
  assert.equal(id.versionSource, 'env');
  assert.ok(id.processVersion.includes('+b'), 'env version keeps the +b<12> content-hash shape');
});

test('NEGATIVE CONTROL: no env version falls back to package_json and is not a content hash', () => {
  const id = _buildProcessIdentityForTests({ packageVersion: '0.1.0' });
  assert.equal(id.processVersion, '0.1.0');
  assert.equal(id.versionSource, 'package_json');
  assert.ok(!id.processVersion.includes('+b'), 'package.json fallback must not look like a content hash');
});

test('blank env version is treated as absent, not as a version', () => {
  const id = _buildProcessIdentityForTests({ envVersion: '   ', packageVersion: '0.1.0' });
  assert.equal(id.versionSource, 'package_json');
  assert.equal(id.processVersion, '0.1.0');
});

test('env version is trimmed', () => {
  const id = _buildProcessIdentityForTests({ envVersion: ' 0.1.0+babc12345678\n', packageVersion: '0.1.0' });
  assert.equal(id.processVersion, '0.1.0+babc12345678');
  assert.equal(id.versionSource, 'env');
});

test('neither input yields unversioned with a literal unknown', () => {
  const id = _buildProcessIdentityForTests({});
  assert.equal(id.processVersion, 'unknown');
  assert.equal(id.versionSource, 'unversioned');
});

test('startedAt and pid come from the supplied facts', () => {
  const id = _buildProcessIdentityForTests(
    { envVersion: '0.1.0+bdeadbeef000' },
    { startedAt: '2026-10-10T15:53:58.000Z', pid: 96847 },
  );
  assert.equal(id.startedAt, '2026-10-10T15:53:58.000Z');
  assert.equal(id.pid, 96847);
});

// ── getProcessIdentity: frozen once per process ─────────────────────────

test('getProcessIdentity resolves once and then ignores later inputs', () => {
  _resetProcessIdentityForTests();
  const first = getProcessIdentity({ envVersion: '0.1.0+bdeadbeef000', packageVersion: '0.1.0' });
  const second = getProcessIdentity({ envVersion: '0.1.0+bfffffffffff', packageVersion: '9.9.9' });
  assert.deepEqual(second, first, 'later env values must not retroactively change the identity');
  assert.equal(second.versionSource, 'env');
  _resetProcessIdentityForTests();
});

test('the frozen identity carries this process pid and an ISO startedAt', () => {
  _resetProcessIdentityForTests();
  const id = getProcessIdentity({ packageVersion: '0.1.0' });
  assert.equal(id.pid, process.pid);
  assert.match(id.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Number.isFinite(Date.parse(id.startedAt)), 'startedAt must be parseable');
  _resetProcessIdentityForTests();
});
