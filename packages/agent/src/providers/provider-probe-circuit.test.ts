import assert from 'node:assert/strict';
import test from 'node:test';
import {
  _resetProviderProbeCircuitsForTests,
  isProviderProbeCircuitOpen,
  isTransportProbeFailure,
  noteProviderProbeFailure,
  noteProviderProbeSuccess,
} from './provider-probe-circuit.js';

const BASE_MS = 5_000;
const MAX_MS = 5 * 60_000;

test('circuit backoff grows via repeated transport failures and latches at 5m', () => {
  _resetProviderProbeCircuitsForTests();
  const now = 1_000_000;
  const s1 = noteProviderProbeFailure('lmstudio-win', 'ECONNREFUSED', now);
  assert.equal(s1.openUntil - now, BASE_MS);
  assert.equal(s1.latched, false);
  const s2 = noteProviderProbeFailure('lmstudio-win', 'ECONNREFUSED', now + 1);
  assert.equal(s2.openUntil - (now + 1), BASE_MS * 2);
  const s3 = noteProviderProbeFailure('lmstudio-win', 'ECONNREFUSED', now + 2);
  assert.equal(s3.openUntil - (now + 2), BASE_MS * 4);
  const s4 = noteProviderProbeFailure('lmstudio-win', 'ECONNREFUSED', now + 3);
  assert.equal(s4.openUntil - (now + 3), BASE_MS * 8);
  const s5 = noteProviderProbeFailure('lmstudio-win', 'ECONNREFUSED', now + 4);
  assert.equal(s5.consecutiveFailures, 5);
  assert.equal(s5.latched, true);
  assert.equal(s5.openUntil - (now + 4), MAX_MS);
  const s6 = noteProviderProbeFailure('lmstudio-win', 'ECONNREFUSED', now + 5);
  assert.equal(s6.latched, true);
  assert.equal(s6.openUntil - (now + 5), MAX_MS);
});

test('circuit opens after failure and closes after success', () => {
  _resetProviderProbeCircuitsForTests();
  const now = 1_000_000;
  const state = noteProviderProbeFailure('lmstudio-win', 'This operation was aborted', now);
  assert.equal(state.consecutiveFailures, 1);
  assert.equal(isProviderProbeCircuitOpen('lmstudio-win', now + 1), true);
  assert.equal(isProviderProbeCircuitOpen('lmstudio-win', now + BASE_MS + 1), false);

  noteProviderProbeSuccess('lmstudio-win', now + 10_000);
  assert.equal(isProviderProbeCircuitOpen('lmstudio-win', now + 10_000), false);
});

test('isTransportProbeFailure matches timeout and abort, not HTTP status', () => {
  assert.equal(isTransportProbeFailure('ECONNREFUSED'), true);
  assert.equal(isTransportProbeFailure('This operation was aborted'), true);
  assert.equal(isTransportProbeFailure('fetch failed'), true);
  assert.equal(isTransportProbeFailure('HTTP 503'), false);
  assert.equal(isTransportProbeFailure('HTTP 401'), false);
});
