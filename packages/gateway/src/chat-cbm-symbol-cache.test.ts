import test from 'node:test';
import assert from 'node:assert/strict';
import { _SessionSymbolCache, type CachedSymbolRef } from './chat-cbm-symbol-cache.js';

const symbol: CachedSymbolRef = { id: 'symbol-1', name: 'run', kind: 'function', file: 'src/run.ts' };

test('CBM symbol cache drains only the requested session', () => {
  const cache = createCache();
  const tokenA = cache.beginResolution('session-a');
  const tokenB = cache.beginResolution('session-b');
  cache.completeResolution('session-a', tokenA, 'call-a', [symbol]);
  cache.completeResolution('session-b', tokenB, 'call-b', [symbol]);

  assert.deepEqual([...cache.drain('session-a').keys()], ['call-a']);
  assert.equal(cache.metrics().activeSessions, 1);
  assert.deepEqual([...cache.drain('session-b').keys()], ['call-b']);
});

test('CBM symbol cache removes a failed empty session immediately', () => {
  const cache = createCache();
  const token = cache.beginResolution('failed-session');
  cache.failResolution('failed-session', token);

  assert.equal(cache.metrics().activeSessions, 0);
  assert.equal(cache.metrics().failedSessionCleanups, 1);
  assert.equal(cache.metrics().resolutionFailures, 1);
});

test('CBM symbol cache expires sessions and reports evictions', () => {
  let now = 1_000;
  const cache = createCache({ ttlMs: 100, now: () => now });
  const token = cache.beginResolution('expiring-session');
  cache.completeResolution('expiring-session', token, 'call-1', [symbol]);
  now += 101;

  assert.equal(cache.sweepExpired(), 1);
  assert.equal(cache.metrics().expiredSessions, 1);
  assert.equal(cache.metrics().expiredCalls, 1);
});

test('CBM symbol cache bounds sessions and calls with observable eviction', () => {
  let now = 1_000;
  const cache = createCache({ maxSessions: 1, maxCallsPerSession: 1, now: () => now });
  const firstToken = cache.beginResolution('session-a');
  cache.completeResolution('session-a', firstToken, 'call-a', [symbol]);
  now += 1;
  const secondToken = cache.beginResolution('session-b');
  cache.completeResolution('session-b', secondToken, 'call-b', [symbol]);
  const thirdToken = cache.beginResolution('session-b');
  cache.completeResolution('session-b', thirdToken, 'call-c', [symbol]);

  const metrics = cache.metrics();
  assert.equal(metrics.capacitySessionEvictions, 1);
  assert.equal(metrics.capacityCallEvictions, 1);
  assert.deepEqual([...cache.drain('session-b').keys()], ['call-c']);
});

test('CBM symbol cache rejects writes that finish after session drain', () => {
  const cache = createCache();
  const token = cache.beginResolution('session-a');
  cache.drain('session-a');

  assert.equal(cache.completeResolution('session-a', token, 'late-call', [symbol]), false);
  assert.equal(cache.metrics().activeSessions, 0);
  assert.equal(cache.metrics().lateWriteDrops, 1);
});

function createCache(overrides: Partial<ConstructorParameters<typeof _SessionSymbolCache>[0]> = {}) {
  return new _SessionSymbolCache({
    ttlMs: 1_000,
    maxSessions: 10,
    maxCallsPerSession: 10,
    ...overrides,
  });
}
