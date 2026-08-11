/**
 * Regression tests for WeClaw install-script hash verification.
 *
 * The bug being fixed: `installWeclaw()` executed `curl -sSL ... | sh` with no
 * verification — a remote install script ran with the bot's privileges, and any
 * compromise of the GitHub repo/CDN meant arbitrary code execution. Auto-install
 * was also on by default (`WECLAW_AUTO_INSTALL !== '0'`).
 *
 * The fix: auto-install is opt-in (`WECLAW_AUTO_INSTALL === '1'`) AND the
 * install script's sha256 must be pinned via `WECLAW_INSTALL_SHA256`. These
 * tests pin the verification decision logic (no network).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getWeclawSendHealth,
  hashInstallScript,
  resetWeclawSendHealthForTests,
  splitWeclawText,
  verifyInstallScript,
} from './weclaw.js';

test('hashInstallScript computes a stable sha256 hex digest', () => {
  const script = 'echo hello\n';
  const h = hashInstallScript(script);
  assert.equal(h.length, 64, 'sha256 hex digest is 64 chars');
  assert.match(h, /^[0-9a-f]{64}$/);
  // Deterministic across calls
  assert.equal(hashInstallScript(script), h);
});

test('hashInstallScript differs for different script content', () => {
  assert.notEqual(hashInstallScript('echo a'), hashInstallScript('echo b'));
});

test('verifyInstallScript refuses when no hash is pinned (supply-chain guard)', () => {
  const err = verifyInstallScript('echo install', undefined);
  assert.ok(err, 'must refuse without a pinned hash');
  assert.match(err!, /WECLAW_INSTALL_SHA256 is not set/);
});

test('verifyInstallScript refuses empty-string expected hash', () => {
  const err = verifyInstallScript('echo install', '');
  assert.ok(err);
  assert.match(err!, /WECLAW_INSTALL_SHA256 is not set/);
});

test('verifyInstallScript accepts when the hash matches', () => {
  const script = '#!/bin/sh\necho installing weclaw\n';
  const err = verifyInstallScript(script, hashInstallScript(script));
  assert.equal(err, null, 'matching hash must pass');
});

test('verifyInstallScript refuses on hash mismatch (tampered/replaced script)', () => {
  const script = '#!/bin/sh\necho malicious\n';
  const expected = hashInstallScript('#!/bin/sh\necho legitimate\n');
  const err = verifyInstallScript(script, expected);
  assert.ok(err);
  assert.match(err!, /sha256 mismatch/);
  assert.ok(err!.includes(expected), 'error reports the expected hash');
});

test('splitWeclawText keeps short messages intact', () => {
  assert.deepEqual(splitWeclawText('hello'), ['hello']);
});

test('splitWeclawText splits on newlines near the limit', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line-${i} ${'x'.repeat(40)}`);
  const text = lines.join('\n');
  const chunks = splitWeclawText(text, 200);
  assert.ok(chunks.length > 1);
  // Content is preserved (whitespace-normalized at chunk boundaries only).
  assert.ok(chunks.join('\n').includes('line-0'));
  assert.ok(chunks.join('\n').includes('line-39'));
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 200, `chunk length ${chunk.length} exceeds limit`);
  }
});

test('getWeclawSendHealth starts healthy after reset', () => {
  resetWeclawSendHealthForTests();
  const health = getWeclawSendHealth();
  assert.equal(health.sendHealthy, true);
  assert.equal(health.consecutiveFailures, 0);
  assert.equal(health.lastError, null);
});
