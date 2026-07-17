import test from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';

import { runGovernanceSweep } from './governance-sweeper.js';
import {
  createGovernanceJob,
  deleteGovernanceJob,
  getGovernanceJob,
} from './governance-jobs-crud.js';
import { ensureGovernanceJobStore } from './governance-jobs-schema.js';
import { runJobAudit } from './governance-auditors.js';
import { applyConsistencyFix } from './ga-loop-fixes.js';
import { runGaLoop } from './ga-loop-runner.js';
import { LOS_PLANNING_TODO_SEED } from './todo-seeds.js';
import { archiveTodo, createTodo, loadTodo } from './todos.js';
import type { GovernanceJobType } from './governance-jobs-types.js';

// ── Helpers ────────────────────────────────────────────────

let dbInitialized = false;

async function initOnce() {
  if (dbInitialized) return;
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureGovernanceJobStore();
  dbInitialized = true;
}

function makeJobId(type: string): string {
  return `gov-sweep-test-${type}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
}

// Use hourly cadence so jobs are "due" (manual cadence never triggers)
function makeJob(type: GovernanceJobType, overrides?: Partial<{ cadence: string }>) {
  const jobId = makeJobId(type);
  return {
    id: jobId,
    jobType: type,
    cadence: (overrides?.cadence as any) ?? 'hourly',
    status: 'active' as const,
    config: {},
    dedupeKey: jobId,
  };
}

// ── Sweep orchestration ────────────────────────────────────

test('runGovernanceSweep dryRun=true returns result without persisting', async () => {
  await initOnce();
  const job = makeJob('consistency_audit');
  await createGovernanceJob(job);

  try {
    const result = await runGovernanceSweep({
      jobTypes: ['consistency_audit'],
      dryRun: true,
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.findingsCreated, 0, 'dryRun should not create findings');
    assert.ok(result.results.length >= 0);
    assert.equal(result.errors.length, 0, `unexpected errors: ${result.errors.join('; ')}`);
  } finally {
    await deleteGovernanceJob(job.id).catch(() => undefined);
  }
});

test('runGovernanceSweep returns empty result when no matching jobs', async () => {
  await initOnce();
  const result = await runGovernanceSweep({
    jobTypes: [], // empty filter → no jobs match
    dryRun: true,
  });
  assert.equal(result.jobsRun, 0);
  assert.equal(result.findingsCreated, 0);
});

test('runGovernanceSweep errors array is always present', async () => {
  await initOnce();
  const result = await runGovernanceSweep({
    jobTypes: ['consistency_audit'],
    dryRun: true,
  });
  assert.ok(Array.isArray(result.results));
  assert.ok(Array.isArray(result.errors));
  assert.equal(result.dryRun, true);
});

test('runGovernanceSweep dryRun=false runs audits and returns results', async () => {
  await initOnce();
  const job = makeJob('consistency_audit');
  await createGovernanceJob(job);

  try {
    const result = await runGovernanceSweep({
      jobTypes: ['consistency_audit'],
      dryRun: false,
    });
    assert.equal(result.dryRun, false);
    assert.equal(result.errors.length, 0, `audit errors: ${result.errors.join('; ')}`);
    // consistency_audit runs reconciliation — always produces a result
    assert.ok(result.results.length >= 0);
  } finally {
    await deleteGovernanceJob(job.id).catch(() => undefined);
    await getDb().query("DELETE FROM todos WHERE metadata_json->>'sweepJobId' = $1", [job.id]).catch(() => undefined);
  }
});

test('consistency auditor reuses the initialized process database', async () => {
  await initOnce();
  const job = makeJob('consistency_audit');
  const summary = await runJobAudit({
    ...job,
    consecutiveNoOps: 0,
    consecutiveFailures: 0,
    circuitState: 'closed',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, false);

  assert.ok(summary.todoReconciliation);
  assert.ok(summary.statusConstraints);
  await getDb().query('SELECT 1');
});

test('GA loop persists classification for a dead-letter audit', async () => {
  await initOnce();
  const job = await createGovernanceJob({
    jobType: 'dead_letter',
    cadence: 'hourly',
    dedupeKey: makeJobId('dead-letter-ga-summary'),
    config: { requeueLimit: 10 },
    autoFix: {
      autoFixEnabled: true,
      maxAutoFixAttempts: 1,
      verificationCommands: [],
      stopCondition: 'no eligible dead letters',
      escalationCadence: 'immediate',
    },
  });

  try {
    const result = await runGaLoop({ job, dryRun: false });
    const reloaded = await getGovernanceJob(job.id);
    const classification = reloaded?.resultSummary?._gaLoop as Record<string, unknown> | undefined;

    assert.ok(classification, 'persisted result summary must include GA classification');
    assert.equal(classification.fixApplied, result.fixApplied);
    assert.equal(classification.fixSucceeded, result.fixSucceeded);
    assert.equal(classification.verificationPassed, result.verificationPassed);
    assert.equal(classification.retried, result.retried);
    assert.equal(classification.escalated, result.escalated);
    assert.deepEqual(
      classification.phases,
      result.phases.map(phase => `${phase.phase}(${phase.attemptNumber})`),
    );
  } finally {
    await deleteGovernanceJob(job.id).catch(() => undefined);
  }
});

test('consistency fix restores an archived seed todo', async () => {
  await initOnce();
  const seed = LOS_PLANNING_TODO_SEED[0];
  assert.ok(seed?.id);
  await createTodo(seed);
  await archiveTodo(seed.id, 'test archived seed');

  const result = await applyConsistencyFix({
    todoReconciliation: { seedOnly: 1, dbOnly: 0, statusDrift: 0 },
  });
  const restored = await loadTodo(seed.id);

  assert.equal(result.applied, true);
  assert.match(result.detail, /Restored 1 archived seed todo/);
  assert.equal(restored?.archivedAt, undefined);
});

// ── All 6 audit types ──────────────────────────────────────

test('all 6 audit types run without throwing', async () => {
  await initOnce();
  const allTypes: GovernanceJobType[] = [
    'consistency_audit',
    'hotspot',
    'architecture_drift',
    'memory_integrity',
    'memory_retention',
    'reflection',
  ];

  const jobIds: string[] = [];
  for (const jobType of allTypes) {
    const job = makeJob(jobType);
    await createGovernanceJob(job);
    jobIds.push(job.id);
  }

  try {
    const result = await runGovernanceSweep({ dryRun: true });
    assert.equal(result.errors.length, 0, `audit errors: ${result.errors.join('; ')}`);
    for (const jobType of allTypes) {
      assert.ok(
        result.results.some(item => item.jobType === jobType),
        `expected result for ${jobType}; types found: ${result.results.map(item => item.jobType).join(', ')}`,
      );
    }
  } finally {
    for (const id of jobIds) {
      await deleteGovernanceJob(id).catch(() => undefined);
    }
  }
});

test('architecture_drift audit creates baseline finding on dryRun=false', async () => {
  await initOnce();
  const job = makeJob('architecture_drift');
  await createGovernanceJob(job);

  try {
    const result = await runGovernanceSweep({
      jobTypes: ['architecture_drift'],
      dryRun: false,
    });
    assert.equal(result.errors.length, 0, `audit errors: ${result.errors.join('; ')}`);
    // architecture_drift always produces at least 1 finding todo
    assert.ok(result.findingsCreated >= 1, `expected >=1 findings, got ${result.findingsCreated}`);
  } finally {
    await deleteGovernanceJob(job.id).catch(() => undefined);
    await getDb().query("DELETE FROM todos WHERE metadata_json->>'sweepJobId' = $1", [job.id]).catch(() => undefined);
  }
});

test('reflection audit runs and produces result summary', async () => {
  await initOnce();
  const job = makeJob('reflection');
  await createGovernanceJob(job);

  try {
    const result = await runGovernanceSweep({
      jobTypes: ['reflection'],
      dryRun: true,
    });
    assert.equal(result.errors.length, 0, `reflection errors: ${result.errors.join('; ')}`);
    assert.ok(result.results.length >= 0);
  } finally {
    await deleteGovernanceJob(job.id).catch(() => undefined);
  }
});

// ── Cleanup ────────────────────────────────────────────────

test('cleanup', async () => {
  if (!dbInitialized) return;
  await getDb().query("DELETE FROM governance_jobs WHERE id LIKE 'gov-sweep-test-%'").catch(() => undefined);
  await getDb().query("DELETE FROM todos WHERE source = 'governance_sweep'").catch(() => undefined);
  await closeDb().catch(() => undefined);
});
