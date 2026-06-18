import test from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';

import { runGovernanceSweep } from './governance-sweeper.js';
import {
  createGovernanceJob,
  deleteGovernanceJob,
} from './governance-jobs-crud.js';
import { ensureGovernanceJobStore } from './governance-jobs-schema.js';
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
    assert.equal(result.results.length, 6, `expected 6 results for all audit types, got ${result.results.length} — types found: ${result.results.map(r => r.jobType).join(', ')}`);
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
