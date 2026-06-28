/**
 * GA loop integration tests — unit-level tests that don't require a live DB.
 *
 * DB-backed integration tests should be run separately with:
 *   LOS_ALLOW_LIVE_TEST_DB=1 pnpm test
 *
 * This file covers pure-function aspects of the GA loop that exercise the
 * integration between the circuit breaker and the sweeper.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SEED_JOBS } from './governance-jobs-schema.js';
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

describe('GA loop seed config', () => {
  it('consistency_audit seed has autoFix enabled', () => {
    const seed = SEED_JOBS.find(s => s.jobType === 'consistency_audit');
    assert.ok(seed);
    assert.ok(seed.autoFix);
    assert.equal(seed.autoFix.autoFixEnabled, true);
    assert.equal(seed.autoFix.maxAutoFixAttempts, 3);
    assert.ok(seed.autoFix.verificationCommands);
    assert.ok(seed.autoFix.stopCondition);
    assert.equal(seed.autoFix.escalationCadence, 'after_retry');
  });

  it('hotspot seed has no autoFix (manual-only for now)', () => {
    const seed = SEED_JOBS.find(s => s.jobType === 'hotspot');
    assert.ok(seed);
    assert.equal(seed.autoFix, undefined);
  });

  it('architecture_drift seed has no autoFix', () => {
    const seed = SEED_JOBS.find(s => s.jobType === 'architecture_drift');
    assert.ok(seed);
    assert.equal(seed.autoFix, undefined);
  });

  it('all seed jobs have valid job types', () => {
    const validTypes = ['consistency_audit', 'hotspot', 'architecture_drift', 'memory_integrity', 'memory_retention', 'reflection', 'branch_cleanup', 'related_project_scan', 'file_size', 'supply_chain_audit', 'static_analysis', 'performance_audit', 'migration_drift_fix'];
    for (const seed of SEED_JOBS) {
      assert.ok(validTypes.includes(seed.jobType), `Unknown job type: ${seed.jobType}`);
      assert.ok(seed.dedupeKey);
      assert.ok(seed.cadence);
    }
  });
});

describe('GA loop circuit breaker ↔ sweeper integration', () => {
  it('sweeper skips job when circuit is open', () => {
    const job = makeJob({ circuitState: 'open', status: 'paused' });
    const decision = evaluateLoopGate(job);
    assert.equal(decision.action, 'skip');
  });

  it('sweeper runs job when gates pass', () => {
    const job = makeJob();
    const decision = evaluateLoopGate(job);
    assert.equal(decision.action, 'run');
  });

  it('no-op throttle downgrades after 3 consecutive empty runs', () => {
    const job = makeJob({ consecutiveNoOps: 3, cadence: 'daily' });
    const decision = evaluateLoopGate(job);
    assert.equal(decision.action, 'downgrade');
    assert.equal(decision.newCadence, 'weekly');
  });

  it('no-op throttle pauses after 5 consecutive empty runs', () => {
    const job = makeJob({ consecutiveNoOps: 5 });
    const decision = evaluateLoopGate(job);
    assert.equal(decision.action, 'pause');
  });

  it('circuit breaker transitions half_open → closed on successful recovery', () => {
    const job = makeJob({ circuitState: 'half_open', circuitOpenedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });
    const decision = evaluateLoopGate(job);
    assert.equal(decision.action, 'run');
    assert.equal(decision.newCircuitState, 'closed');
  });

  it('auto-recovers paused jobs with closed circuit', () => {
    const job = makeJob({ status: 'paused', circuitState: 'closed' });
    assert.equal(maybeAutoRecoverPaused(job), true);
  });

  it('does not auto-recover paused jobs with recent open circuit', () => {
    const job = makeJob({ status: 'paused', circuitState: 'open', circuitOpenedAt: new Date().toISOString() });
    assert.equal(maybeAutoRecoverPaused(job), false);
  });

  it('state transitions after successful run reset counters', () => {
    const job = makeJob({ consecutiveNoOps: 3, consecutiveFailures: 2 });
    const next = computeNextState(job, true, false);
    assert.equal(next.consecutiveNoOps, 0);
    assert.equal(next.consecutiveFailures, 0);
    assert.equal(next.circuitState, 'closed');
  });

  it('state transitions after failed run increment failures', () => {
    const job = makeJob({ consecutiveFailures: 1 });
    const next = computeNextState(job, false, true);
    assert.equal(next.consecutiveFailures, 2);
    assert.equal(next.circuitState, 'closed'); // not at threshold yet
  });
});
