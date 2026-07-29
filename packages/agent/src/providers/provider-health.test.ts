/**
 * @los/agent/providers/provider-health.test — Health score computation tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeHealthScore,
  rankByHealth,
  selectHealthiest,
  isUnhealthy,
  isHealthierThan,
} from './provider-health.js';
import type { ProbeResult } from './provider-probe.js';
import type { ProviderRecentOutcome } from './provider-health.js';

// ── Helpers ────────────────────────────────────────────

function probe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    provider: 'test-provider',
    baseUrl: 'https://api.test.com/v1',
    rttMs: 200,
    statusCode: 200,
    healthy: true,
    probedAt: new Date().toISOString(),
    ...overrides,
  };
}

function outcomes(overrides: Partial<ProviderRecentOutcome> = {}): ProviderRecentOutcome {
  return {
    provider: 'test-provider',
    model: 'test-model',
    totalTasks: 10,
    succeeded: 10,
    failed: 0,
    avgDurationMs: 1500,
    avgTokens: 5000,
    lastOutcomeAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── computeHealthScore ─────────────────────────────────

describe('computeHealthScore', () => {
  it('scores a perfectly healthy provider at 1.0', () => {
    // RTT 1ms (realistic minimum), perfect success, available
    // rttScore=1-1/5000≈1.0, successRate=1.0, availability=1.0
    // score = 0.4*1.0 + 0.4*1.0 + 0.2*1.0 = 1.0
    const score = computeHealthScore('p1', probe({ rttMs: 1 }), outcomes());
    assert.equal(score.tier, 'healthy');
    assert.equal(score.score, 1);
  });

  it('scores a provider with moderate RTT and perfect success at ~0.86', () => {
    // RTT 500ms → rttScore = 1 - 500/5000 = 0.9
    // success = 10/10 = 1.0
    // availability = 1.0
    // score = 0.4*0.9 + 0.4*1.0 + 0.2*1.0 = 0.36+0.4+0.2 = 0.96
    const score = computeHealthScore('p1', probe({ rttMs: 500 }), outcomes());
    assert.equal(score.tier, 'healthy');
    assert.equal(score.score, 0.96);
  });

  it('scores a provider with max RTT (5000ms) at rttScore=0', () => {
    // RTT 5000ms → rttScore = 0
    // success = 1.0, availability = 1.0
    // score = 0.4*0 + 0.4*1.0 + 0.2*1.0 = 0.6
    const score = computeHealthScore('p1', probe({ rttMs: 5000 }), outcomes());
    assert.equal(score.score, 0.6);
    assert.equal(score.tier, 'degraded');
  });

  it('caps RTT score at 0 for RTT > 5000ms', () => {
    const score = computeHealthScore('p1', probe({ rttMs: 10000 }), outcomes());
    // rttScore = max(0, 1-10000/5000) = 0
    // score = 0.4*0 + 0.4*1.0 + 0.2*1.0 = 0.6
    assert.equal(score.components.rttScore, 0);
    assert.equal(score.score, 0.6);
  });

  it('penalizes unhealthy probe with zero availability score', () => {
    // unhealthy probe → rttScore=0, availability=0
    // success=1.0
    // score = 0.4*0 + 0.4*1.0 + 0.2*0 = 0.4
    const score = computeHealthScore('p1', probe({ healthy: false, rttMs: 200 }), outcomes());
    assert.equal(score.components.availabilityScore, 0);
    assert.equal(score.score, 0.4);
    assert.equal(score.tier, 'unhealthy');
  });

  it('uses neutral defaults when no probe data is available', () => {
    // No probe → rttScore=0.5, availabilityScore=0.5
    // success=1.0
    // score = 0.4*0.5 + 0.4*1.0 + 0.2*0.5 = 0.2+0.4+0.1 = 0.7
    const score = computeHealthScore('p1', undefined, outcomes());
    assert.equal(score.components.rttScore, 0.5);
    assert.equal(score.components.availabilityScore, 0.5);
    assert.equal(score.score, 0.7);
    assert.equal(score.tier, 'degraded');
    assert.equal(score.details.hasProbe, false);
    assert.equal(score.details.hasOutcomes, true);
  });

  it('gives benefit of doubt when no outcome data exists', () => {
    // No outcomes → successRate=1.0 (benefit of doubt)
    const score = computeHealthScore('p1', probe(), undefined);
    assert.equal(score.components.successRate, 1);
    assert.equal(score.details.hasOutcomes, false);
  });

  it('blends success rate toward 0.5 when too few tasks for trust', () => {
    // 1 task, 1 success → raw=1.0, trustWeight=1/3≈0.33
    // blended = 1.0*0.33 + 0.5*0.67 ≈ 0.67
    const score = computeHealthScore('p1', probe({ rttMs: 500 }), outcomes({ totalTasks: 1, succeeded: 1 }));
    assert.ok(score.components.successRate > 0.6 && score.components.successRate < 0.75,
      `expected 0.6-0.75, got ${score.components.successRate}`);
  });

  it('trusts success rate fully when task count meets threshold', () => {
    const score = computeHealthScore('p1', probe({ rttMs: 500 }), outcomes({ totalTasks: 3, succeeded: 2 }));
    // 2/3 ≈ 0.666..., rounded to 0.67
    assert.equal(score.components.successRate, 0.67);
  });

  it('classifies tier correctly at boundaries', () => {
    // With low RTT (100ms) and perfect success → score should be healthy (≈0.96)
    const healthy = computeHealthScore('p1', probe({ rttMs: 100 }), outcomes({ totalTasks: 10, succeeded: 10 }));
    assert.equal(healthy.tier, 'healthy');
    // With high RTT and no outcome data → degraded (~0.5)
    const degraded = computeHealthScore('p2', probe({ rttMs: 5000, healthy: true }), undefined);
    // rttScore=0, successRate=1.0 (benefit of doubt), availability=1.0
    // score = 0.4*0 + 0.4*1.0 + 0.2*1.0 = 0.6
    assert.equal(degraded.score, 0.6);
    assert.equal(degraded.tier, 'degraded');
    // With unhealthy probe and no outcomes → unhealthy (~0.4)
    const unhealthy = computeHealthScore('p3', probe({ healthy: false }), undefined);
    assert.equal(unhealthy.tier, 'unhealthy');
  });
});

// ── rankByHealth ───────────────────────────────────────

describe('rankByHealth', () => {
  it('ranks healthy > degraded > unhealthy', () => {
    const scores = [
      computeHealthScore('unhealthy', probe({ healthy: false }), undefined),
      computeHealthScore('degraded', undefined, outcomes()),
      computeHealthScore('healthy', probe({ rttMs: 0 }), outcomes()),
    ];
    const ranked = rankByHealth(scores);
    assert.deepEqual(ranked.map(s => s.provider), ['healthy', 'degraded', 'unhealthy']);
  });

  it('ranks by score within the same tier', () => {
    const p1 = computeHealthScore('fast', probe({ rttMs: 100 }), outcomes());   // higher score
    const p2 = computeHealthScore('slow', probe({ rttMs: 2000 }), outcomes()); // lower score
    assert.ok(p1.score > p2.score);
    const ranked = rankByHealth([p2, p1]);
    assert.deepEqual(ranked.map(s => s.provider), ['fast', 'slow']);
  });

  it('handles empty list', () => {
    assert.deepEqual(rankByHealth([]), []);
  });
});

// ── selectHealthiest ───────────────────────────────────

describe('selectHealthiest', () => {
  it('returns undefined for empty list', () => {
    assert.equal(selectHealthiest([]), undefined);
  });

  it('returns the healthiest provider', () => {
    const scores = [
      computeHealthScore('degraded', undefined, outcomes()),
      computeHealthScore('healthy', probe({ rttMs: 0 }), outcomes()),
      computeHealthScore('unhealthy', probe({ healthy: false }), undefined),
    ];
    const best = selectHealthiest(scores);
    assert.ok(best);
    assert.equal(best.provider, 'healthy');
  });
});

// ── isUnhealthy ────────────────────────────────────────

describe('isUnhealthy', () => {
  it('returns true for unhealthy tier', () => {
    const score = computeHealthScore('p1', probe({ healthy: false }), undefined);
    assert.equal(isUnhealthy(score), true);
  });

  it('returns false for healthy tier', () => {
    const score = computeHealthScore('p1', probe({ rttMs: 0 }), outcomes());
    assert.equal(isUnhealthy(score), false);
  });

  it('returns false for degraded tier', () => {
    const score = computeHealthScore('p1', undefined, outcomes());
    assert.equal(isUnhealthy(score), false);
  });
});

// ── isHealthierThan ────────────────────────────────────

describe('isHealthierThan', () => {
  it('healthy is healthier than degraded', () => {
    const a = computeHealthScore('a', probe({ rttMs: 0 }), outcomes());
    const b = computeHealthScore('b', undefined, outcomes());
    assert.equal(isHealthierThan(a, b), true);
    assert.equal(isHealthierThan(b, a), false);
  });

  it('degraded is healthier than unhealthy', () => {
    const a = computeHealthScore('a', undefined, outcomes());
    const b = computeHealthScore('b', probe({ healthy: false }), undefined);
    assert.equal(isHealthierThan(a, b), true);
  });

  it('same tier returns false regardless of score', () => {
    const a = computeHealthScore('a', probe({ rttMs: 100 }), outcomes());
    const b = computeHealthScore('b', probe({ rttMs: 500 }), outcomes());
    assert.equal(isHealthierThan(a, b), false);
    assert.equal(isHealthierThan(b, a), false);
  });
});
