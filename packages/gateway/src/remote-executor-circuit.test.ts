import assert from 'node:assert/strict';
import test from 'node:test';
import {
  _resetRemoteExecutorCircuitsForTests,
  isHeartbeatStaleForOutbound,
  isRemoteCircuitOpen,
  noteRemoteExecutorFailure,
  noteRemoteExecutorSuccess,
} from './remote-executor-circuit.js';

const BASE_MS = 5_000;
const MAX_MS = 5 * 60_000;
const STALE_MS = 45_000;

test('circuit backoff grows via repeated failures and caps open window', () => {
  _resetRemoteExecutorCircuitsForTests();
  const now = 1_000_000;
  const s1 = noteRemoteExecutorFailure('n', 'ECONNREFUSED', now);
  assert.equal(s1.openUntil - now, BASE_MS);
  const s2 = noteRemoteExecutorFailure('n', 'ECONNREFUSED', now + 1);
  assert.equal(s2.openUntil - (now + 1), BASE_MS * 2);
  const s3 = noteRemoteExecutorFailure('n', 'ECONNREFUSED', now + 2);
  assert.equal(s3.openUntil - (now + 2), BASE_MS * 4);
  // Keep failing until cap
  let last = s3;
  let t = now + 3;
  for (let i = 0; i < 10; i += 1) {
    last = noteRemoteExecutorFailure('n', 'ECONNREFUSED', t);
    t += 1;
  }
  assert.ok(last.openUntil - (t - 1) <= MAX_MS);
  assert.equal(last.openUntil - (t - 1), MAX_MS);
});

test('circuit opens after failure and closes after success', () => {
  _resetRemoteExecutorCircuitsForTests();
  const now = 1_000_000;
  const state = noteRemoteExecutorFailure('node34-executor-1', 'ECONNREFUSED', now);
  assert.equal(state.consecutiveFailures, 1);
  assert.equal(state.openUntil, now + BASE_MS);
  assert.equal(isRemoteCircuitOpen('node34-executor-1', now + 1), true);
  assert.equal(isRemoteCircuitOpen('node34-executor-1', now + BASE_MS + 1), false);

  noteRemoteExecutorSuccess('node34-executor-1', now + 10_000);
  assert.equal(isRemoteCircuitOpen('node34-executor-1', now + 10_000), false);
});

test('repeated failures lengthen open window', () => {
  _resetRemoteExecutorCircuitsForTests();
  const now = 2_000_000;
  noteRemoteExecutorFailure('oracle-executor', 'fetch failed', now);
  const s2 = noteRemoteExecutorFailure('oracle-executor', 'fetch failed', now + 100);
  assert.equal(s2.consecutiveFailures, 2);
  assert.equal(s2.openUntil, now + 100 + BASE_MS * 2);
});


test('isHeartbeatStaleForOutbound uses 45s default', () => {
  const now = Date.now();
  assert.equal(isHeartbeatStaleForOutbound(new Date(now - 10_000).toISOString(), now), false);
  assert.equal(
    isHeartbeatStaleForOutbound(new Date(now - STALE_MS - 1).toISOString(), now),
    true,
  );
  assert.equal(isHeartbeatStaleForOutbound(null, now), true);
});
