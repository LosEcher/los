/**
 * node-health unit tests (B7 node health index, borrowed from
 * mac-performance-monitor PressureIndex band + signal design).
 *
 * Run: node --test src/node-health.test.ts (or via gateway test-runner)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeNodeHealthIndex,
  blockerCountOf,
  hasVerificationGapOf,
  heartbeatAgeSecOf,
} from './node-health.js';

// ── computeNodeHealthIndex ──────────────────────────────────────────────
test('offline node: hard band 0-33, level offline regardless of signals', () => {
  // Even with perfect coverage, an offline node cannot leave the offline band.
  const r = computeNodeHealthIndex('offline', false, {
    modesOk: 1, modesTotal: 1, heartbeatAgeSec: 5, blockerCount: 0,
    hasVerificationGap: false, recovering: false,
  });
  assert.equal(r.level, 'offline');
  assert.equal(r.band, 'offline');
  assert.ok(r.index >= 0 && r.index <= 33, `index ${r.index} in offline band`);
});

test('offline node: stale heartbeat + no coverage drags index down', () => {
  const fresh = computeNodeHealthIndex('offline', false, {
    modesOk: 1, modesTotal: 1, heartbeatAgeSec: 5, blockerCount: 0,
    hasVerificationGap: false, recovering: false,
  });
  const stale = computeNodeHealthIndex('offline', false, {
    modesOk: 0, modesTotal: 1, heartbeatAgeSec: 3600, blockerCount: 0,
    hasVerificationGap: false, recovering: false,
  });
  assert.ok(stale.index < fresh.index, `stale ${stale.index} < fresh ${fresh.index}`);
});

test('online non-candidate: degraded band 34-66', () => {
  const r = computeNodeHealthIndex('online', false, {
    modesOk: 1, modesTotal: 1, heartbeatAgeSec: 10, blockerCount: 1,
    hasVerificationGap: true, recovering: false,
  });
  assert.equal(r.level, 'degraded');
  assert.ok(r.index >= 34 && r.index <= 66, `index ${r.index} in degraded band`);
});

test('online candidate: healthy band 67-100', () => {
  const r = computeNodeHealthIndex('online', true, {
    modesOk: 1, modesTotal: 1, heartbeatAgeSec: 10, blockerCount: 0,
    hasVerificationGap: false, recovering: false,
  });
  assert.equal(r.level, 'healthy');
  assert.ok(r.index >= 67 && r.index <= 100, `index ${r.index} in healthy band`);
});

test('online candidate: recovering penalty lowers score within band', () => {
  const normal = computeNodeHealthIndex('online', true, {
    modesOk: 1, modesTotal: 1, heartbeatAgeSec: 10, blockerCount: 0,
    hasVerificationGap: false, recovering: false,
  });
  const recovering = computeNodeHealthIndex('online', true, {
    modesOk: 1, modesTotal: 1, heartbeatAgeSec: 10, blockerCount: 0,
    hasVerificationGap: false, recovering: true,
  });
  assert.ok(recovering.index < normal.index);
});

test('online candidate: stale heartbeat drags score', () => {
  const fresh = computeNodeHealthIndex('online', true, {
    modesOk: 1, modesTotal: 1, heartbeatAgeSec: 10, blockerCount: 0,
    hasVerificationGap: false, recovering: false,
  });
  const stale = computeNodeHealthIndex('online', true, {
    modesOk: 1, modesTotal: 1, heartbeatAgeSec: 7200, blockerCount: 0,
    hasVerificationGap: false, recovering: false,
  });
  assert.ok(stale.index < fresh.index);
});

// ── blocker helpers ─────────────────────────────────────────────────────
test('blockerCountOf: excludes verification debt, counts others', () => {
  assert.equal(blockerCountOf([]), 0);
  assert.equal(blockerCountOf(['verification:agent_http:not_confirmed']), 0);
  assert.equal(blockerCountOf(['verification:agent_http:not_confirmed', 'resource:low_memory']), 1);
  assert.equal(blockerCountOf(['a', 'b', 'c', 'd']), 4);
  assert.equal(blockerCountOf(null as unknown as string[]), 0);
});

test('hasVerificationGapOf: detects verification debt', () => {
  assert.equal(hasVerificationGapOf([]), false);
  assert.equal(hasVerificationGapOf(['verification:agent_http:not_confirmed']), true);
  assert.equal(hasVerificationGapOf(['resource:low_memory']), false);
  assert.equal(hasVerificationGapOf(null as unknown as string[]), false);
});

// ── heartbeat age ───────────────────────────────────────────────────────
test('heartbeatAgeSecOf: parses ISO and clamps', () => {
  const now = Date.parse('2026-08-27T15:00:00.000Z');
  assert.equal(heartbeatAgeSecOf('2026-08-27T14:59:50.000Z', now), 10);
  assert.equal(heartbeatAgeSecOf('2026-08-27T15:00:10.000Z', now), 0); // future → clamp 0
  assert.equal(heartbeatAgeSecOf(undefined, now), 0);
  assert.equal(heartbeatAgeSecOf('garbage', now), 0);
});
