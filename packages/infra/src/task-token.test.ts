import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { mintTaskToken, verifyTaskToken, verifyTaskTokenWithRotation } from './task-token.js';

const TASK_TOKEN_DEFAULT_TTL_SECONDS = 3_600;
const TASK_TOKEN_MIN_TTL_SECONDS = 60;
const TASK_TOKEN_MAX_TTL_SECONDS = 3_600;

const SECRET = 'test-task-token-secret';
const OTHER_SECRET = 'another-secret';
const NOW = 1_800_000_000; // fixed epoch seconds

function resign(payload: object, secret = SECRET, version = 'lst1'): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const input = `${version}.${body}`;
  const sig = createHmac('sha256', secret).update(input).digest('base64url');
  return `${input}.${sig}`;
}

test('mint → verify round-trips the task/lease/expiry claims', () => {
  const minted = mintTaskToken({
    taskRunId: 'task-a',
    leaseVersion: 7,
    secret: SECRET,
    now: NOW,
  });
  assert.match(minted.token, /^lst1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(minted.claims, {
    taskRunId: 'task-a',
    leaseVersion: 7,
    expiresAt: NOW + TASK_TOKEN_DEFAULT_TTL_SECONDS,
  });

  const verified = verifyTaskToken(minted.token, SECRET, { now: NOW + 10 });
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  assert.deepEqual(verified.claims, minted.claims);
});

test('ttl is clamped to [60s, 1h]', () => {
  const short = mintTaskToken({ taskRunId: 't', leaseVersion: 0, secret: SECRET, ttlSeconds: 5, now: NOW });
  assert.equal(short.claims.expiresAt, NOW + TASK_TOKEN_MIN_TTL_SECONDS);

  const long = mintTaskToken({ taskRunId: 't', leaseVersion: 0, secret: SECRET, ttlSeconds: 999_999, now: NOW });
  assert.equal(long.claims.expiresAt, NOW + TASK_TOKEN_MAX_TTL_SECONDS);
});

test('expired token is rejected with reason=expired (not accepted by clock skew)', () => {
  const minted = mintTaskToken({ taskRunId: 'task-a', leaseVersion: 1, secret: SECRET, now: NOW });
  const atExpiry = verifyTaskToken(minted.token, SECRET, { now: minted.claims.expiresAt });
  assert.deepEqual(atExpiry, { ok: false, reason: 'expired' });
  const beforeExpiry = verifyTaskToken(minted.token, SECRET, { now: minted.claims.expiresAt - 1 });
  assert.equal(beforeExpiry.ok, true);
});

test('tampered payload is rejected as bad_signature', () => {
  const minted = mintTaskToken({ taskRunId: 'task-a', leaseVersion: 1, secret: SECRET, now: NOW });
  const [, , sig] = minted.token.split('.');
  const forged = resign({ tid: 'task-b', lv: 1, exp: minted.claims.expiresAt });
  const forgedParts = forged.split('.');
  // Keep the original signature over the legitimate payload → mismatch.
  const tampered = `${forgedParts[0]}.${forgedParts[1]}.${sig}`;
  assert.deepEqual(verifyTaskToken(tampered, SECRET, { now: NOW }), {
    ok: false,
    reason: 'bad_signature',
  });
});

test('a token signed with another secret is rejected', () => {
  const minted = mintTaskToken({ taskRunId: 'task-a', leaseVersion: 1, secret: OTHER_SECRET, now: NOW });
  assert.deepEqual(verifyTaskToken(minted.token, SECRET, { now: NOW }), {
    ok: false,
    reason: 'bad_signature',
  });
});

test('unknown version, malformed shapes, and missing secret are distinguishable failures', () => {
  const minted = mintTaskToken({ taskRunId: 'task-a', leaseVersion: 1, secret: SECRET, now: NOW });
  const payload = minted.token.split('.')[1];

  assert.deepEqual(verifyTaskToken(undefined, SECRET), { ok: false, reason: 'malformed' });
  assert.deepEqual(verifyTaskToken('lst1.only-two-parts', SECRET), { ok: false, reason: 'malformed' });
  assert.deepEqual(verifyTaskToken('lst1..sig', SECRET), { ok: false, reason: 'malformed' });
  assert.deepEqual(verifyTaskToken(resign({ tid: 't', lv: 1, exp: NOW + 60 }, SECRET, 'lst0'), SECRET), {
    ok: false,
    reason: 'unsupported_version',
  });
  assert.deepEqual(verifyTaskToken(minted.token, undefined), { ok: false, reason: 'not_configured' });

  // Valid signature over a payload that is not a claims object.
  const nonClaims = resign({ hello: 'world' });
  assert.deepEqual(verifyTaskToken(nonClaims, SECRET, { now: NOW }), { ok: false, reason: 'malformed' });

  // Same signature, but the payload was replaced with unparseable bytes.
  const badPayload = `lst1.${Buffer.from('not-json', 'utf8').toString('base64url')}.${payload}`;
  assert.equal(verifyTaskToken(badPayload, SECRET).ok, false);
});

test('claims are stable across repeated verification (no hidden nonce consumption)', () => {
  const minted = mintTaskToken({ taskRunId: 'task-a', leaseVersion: 2, secret: SECRET, now: NOW });
  const first = verifyTaskToken(minted.token, SECRET, { now: NOW + 1 });
  const second = verifyTaskToken(minted.token, SECRET, { now: NOW + 2 });
  assert.deepEqual(first, second);
});

test('mint rejects invalid inputs instead of issuing a half-valid token', () => {
  assert.throws(() => mintTaskToken({ taskRunId: '  ', leaseVersion: 0, secret: SECRET }), /taskRunId/);
  assert.throws(() => mintTaskToken({ taskRunId: 't', leaseVersion: -1, secret: SECRET }), /leaseVersion/);
  assert.throws(() => mintTaskToken({ taskRunId: 't', leaseVersion: 1.5, secret: SECRET }), /leaseVersion/);
  assert.throws(() => mintTaskToken({ taskRunId: 't', leaseVersion: 0, secret: '' }), /secret/);
});

test('rotation accepts previous-secret tokens until their own expiry', () => {
  const previous = mintTaskToken({
    taskRunId: 'task-rotation',
    leaseVersion: 2,
    secret: OTHER_SECRET,
    now: NOW,
  });

  const accepted = verifyTaskTokenWithRotation(previous.token, [SECRET, OTHER_SECRET], { now: NOW + 10 });
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.equal(accepted.claims.taskRunId, 'task-rotation');

  const expired = verifyTaskTokenWithRotation(previous.token, [SECRET, OTHER_SECRET], {
    now: previous.claims.expiresAt,
  });
  assert.deepEqual(expired, { ok: false, reason: 'expired' });

  assert.deepEqual(verifyTaskTokenWithRotation(previous.token, [SECRET], { now: NOW + 10 }), {
    ok: false,
    reason: 'bad_signature',
  });
  assert.deepEqual(verifyTaskTokenWithRotation(previous.token, [], { now: NOW + 10 }), {
    ok: false,
    reason: 'not_configured',
  });
});
