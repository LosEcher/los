import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLoopGate, computeNextState, maybeAutoRecoverPaused } from './ga-circuit-breaker.js';
import type { GovernanceJob } from './governance-jobs-types.js';

function makeJob(overrides: Partial<GovernanceJob> = {}): GovernanceJob {
  return {
    id: 'test-job-1',
    jobType: 'consistency_audit',
    cadence: 'daily',
    status: 'active',
    config: {},
    consecutiveNoOps: 0,
    consecutiveFailures: 0,
    circuitState: 'closed',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('evaluateLoopGate', () => {
  it('allows normal job to run', () => {
    const job = makeJob();
    const decision = evaluateLoopGate(job);
    assert.equal(decision.action, 'run');
    assert.equal(decision.reason, 'all gates passed');
  });

  it('skips when circuit is open', () => {
    const job = makeJob({ circuitState: 'open', status: 'paused' });
    const decision = evaluateLoopGate(job);
    assert.equal(decision.action, 'skip');
    assert.ok(decision.reason.includes('circuit open'));
  });

  it('skips when half_open and recovery window not elapsed', () => {
    const job = makeJob({
      circuitState: 'half_open',
      circuitOpenedAt: new Date().toISOString(), // just now
    });
    const decision = evaluateLoopGate(job);
    assert.equal(decision.action, 'skip');
    assert.ok(decision.reason.includes('half_open'));
  });

  it('allows half_open when recovery window elapsed', () => {
    const job = makeJob({
      circuitState: 'half_open',
      circuitOpenedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25 hours ago
    });
    const decision = evaluateLoopGate(job);
    assert.equal(decision.action, 'run');
    assert.equal(decision.newCircuitState, 'closed');
  });

  it('pauses when no-ops >= 5', () => {
    const job = makeJob({ consecutiveNoOps: 5 });
    const decision = evaluateLoopGate(job);
    assert.equal(decision.action, 'pause');
    assert.equal(decision.newStatus, 'paused');
  });

  it('downgrades cadence when no-ops >= 3 and < 5', () => {
    const job = makeJob({ consecutiveNoOps: 3, cadence: 'daily' });
    const decision = evaluateLoopGate(job);
    assert.equal(decision.action, 'downgrade');
    assert.equal(decision.newCadence, 'weekly');
  });

  it('opens circuit when consecutive failures >= 5', () => {
    const job = makeJob({ consecutiveFailures: 5 });
    const decision = evaluateLoopGate(job);
    assert.equal(decision.action, 'pause');
    assert.equal(decision.newCircuitState, 'open');
  });

  it('goes half_open when consecutive failures >= 3 and < 5', () => {
    const job = makeJob({ consecutiveFailures: 3 });
    const decision = evaluateLoopGate(job);
    assert.equal(decision.action, 'run');
    assert.equal(decision.newCircuitState, 'half_open');
  });
});

describe('computeNextState', () => {
  it('resets no-ops to 0 when findings exist', () => {
    const job = makeJob({ consecutiveNoOps: 3 });
    const next = computeNextState(job, true, false);
    assert.equal(next.consecutiveNoOps, 0);
  });

  it('increments no-ops when no findings', () => {
    const job = makeJob({ consecutiveNoOps: 2 });
    const next = computeNextState(job, false, false);
    assert.equal(next.consecutiveNoOps, 3);
  });

  it('resets failures to 0 when no error', () => {
    const job = makeJob({ consecutiveFailures: 4 });
    const next = computeNextState(job, false, false);
    assert.equal(next.consecutiveFailures, 0);
  });

  it('increments failures on error', () => {
    const job = makeJob({ consecutiveFailures: 2 });
    const next = computeNextState(job, false, true);
    assert.equal(next.consecutiveFailures, 3);
  });

  it('transitions to half_open at threshold', () => {
    const job = makeJob({ consecutiveFailures: 2, circuitState: 'closed' });
    const next = computeNextState(job, false, true);
    assert.equal(next.circuitState, 'half_open');
    assert.ok(next.circuitOpenedAt);
  });

  it('transitions to open at threshold', () => {
    const job = makeJob({ consecutiveFailures: 4, circuitState: 'closed' });
    const next = computeNextState(job, false, true);
    assert.equal(next.circuitState, 'open');
  });

  it('recovers from half_open on success', () => {
    const job = makeJob({ consecutiveFailures: 3, circuitState: 'half_open', circuitOpenedAt: new Date().toISOString() });
    const next = computeNextState(job, true, false);
    assert.equal(next.circuitState, 'closed');
    assert.equal(next.consecutiveFailures, 0);
  });
});

describe('maybeAutoRecoverPaused', () => {
  it('returns false for active jobs', () => {
    const job = makeJob({ status: 'active' });
    assert.equal(maybeAutoRecoverPaused(job), false);
  });

  it('returns true for paused jobs with closed circuit', () => {
    const job = makeJob({ status: 'paused', circuitState: 'closed' });
    assert.equal(maybeAutoRecoverPaused(job), true);
  });

  it('returns true for paused jobs with open circuit past recovery window', () => {
    const job = makeJob({
      status: 'paused',
      circuitState: 'open',
      circuitOpenedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    assert.equal(maybeAutoRecoverPaused(job), true);
  });

  it('returns false for paused jobs with open circuit still in window', () => {
    const job = makeJob({
      status: 'paused',
      circuitState: 'open',
      circuitOpenedAt: new Date().toISOString(),
    });
    assert.equal(maybeAutoRecoverPaused(job), false);
  });
});
