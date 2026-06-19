import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  createGovernanceJob,
  deleteGovernanceJob,
  ensureGovernanceJobStore,
  getGovernanceJob,
  listDueGovernanceJobs,
  listGovernanceJobs,
  runGovernanceSweep,
  seedGovernanceJobs,
  updateGovernanceJob,
} from './governance-jobs.js';

test('governance jobs: create, get, list, update, delete', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  try {
    await ensureGovernanceJobStore();

    // Create
    const created = await createGovernanceJob({
      jobType: 'consistency_audit',
      cadence: 'daily',
      dedupeKey: 'test-consistency-audit',
    });

    assert.ok(created.id.startsWith('govjob-'));
    assert.equal(created.jobType, 'consistency_audit');
    assert.equal(created.cadence, 'daily');
    assert.equal(created.status, 'active');

    // Get
    const found = await getGovernanceJob(created.id);
    assert.ok(found);
    assert.equal(found.jobType, 'consistency_audit');

    // List by type
    const byType = await listGovernanceJobs({ jobType: 'consistency_audit' });
    assert.ok(byType.some(j => j.id === created.id));

    // Update
    const updated = await updateGovernanceJob(created.id, { status: 'paused' });
    assert.equal(updated!.status, 'paused');

    // Delete
    const deleted = await deleteGovernanceJob(created.id);
    assert.equal(deleted, true);

    const gone = await getGovernanceJob(created.id);
    assert.equal(gone, null);
  } finally {
    await closeDb().catch(() => undefined);
  }
});

test('governance jobs: seedGovernanceJobs creates 6 default jobs, idempotent', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  try {
    await ensureGovernanceJobStore();

    // Clean existing seeds
    await getDb().query("DELETE FROM governance_jobs WHERE dedupe_key LIKE 'gov-job-%'").catch(() => undefined);

    const seeded = await seedGovernanceJobs();
    assert.equal(seeded.length, 8);

    const types = seeded.map(j => j.jobType).sort();
    assert.deepEqual(types, ['architecture_drift', 'branch_cleanup', 'consistency_audit', 'hotspot', 'memory_integrity', 'memory_retention', 'reflection', 'related_project_scan']);

    // Verify cadences
    const consistencyJob = seeded.find(j => j.jobType === 'consistency_audit')!;
    assert.equal(consistencyJob.cadence, 'daily');

    const archJob = seeded.find(j => j.jobType === 'architecture_drift')!;
    assert.equal(archJob.cadence, 'weekly');

    // Idempotent: seed again should return same jobs
    const seededAgain = await seedGovernanceJobs();
    assert.equal(seededAgain.length, 8);

    // Cleanup
    for (const j of seeded) {
      await deleteGovernanceJob(j.id).catch(() => undefined);
    }
  } finally {
    await closeDb().catch(() => undefined);
  }
});

test('governance jobs: listDueGovernanceJobs filters by cadence到期', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  try {
    await ensureGovernanceJobStore();

    // Clean existing seeds
    await getDb().query("DELETE FROM governance_jobs WHERE dedupe_key LIKE 'gov-job-%'").catch(() => undefined);

    const daily = await createGovernanceJob({
      jobType: 'consistency_audit',
      cadence: 'daily',
      dedupeKey: 'test-due-daily',
    });

    // Just created (lastRunAt = null) = never run = due
    const due = await listDueGovernanceJobs();
    assert.ok(due.some(j => j.id === daily.id));

    // Update lastRunAt to now = not due
    await updateGovernanceJob(daily.id, { lastRunAt: new Date().toISOString() });
    const dueAfterRun = await listDueGovernanceJobs();
    assert.ok(!dueAfterRun.some(j => j.id === daily.id));

    // Set lastRunAt to 25 hours ago = due (daily threshold is 23h)
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await updateGovernanceJob(daily.id, { lastRunAt: oldDate });
    const dueExpired = await listDueGovernanceJobs();
    assert.ok(dueExpired.some(j => j.id === daily.id));

    // Manual job should never be due
    const manual = await createGovernanceJob({
      jobType: 'hotspot',
      cadence: 'manual',
      dedupeKey: 'test-due-manual',
    });
    const dueWithManual = await listDueGovernanceJobs();
    assert.ok(!dueWithManual.some(j => j.id === manual.id));

    // Cleanup
    await deleteGovernanceJob(daily.id).catch(() => undefined);
    await deleteGovernanceJob(manual.id).catch(() => undefined);
  } finally {
    await closeDb().catch(() => undefined);
  }
});

test('governance jobs: runGovernanceSweep dry-run does not mutate', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  try {
    await ensureGovernanceJobStore();

    // Clean existing seeds
    await getDb().query("DELETE FROM governance_jobs WHERE dedupe_key LIKE 'gov-job-%'").catch(() => undefined);

    await seedGovernanceJobs();

    // Dry run
    const result = await runGovernanceSweep({ dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.jobsSkipped, 0); // All 8 should be due (never run)
    assert.equal(result.jobsRun, 8);
    assert.equal(result.findingsCreated, 0); // No todos in dry-run

    // Verify no mutations
    const job = (await listGovernanceJobs({ jobType: 'consistency_audit' }))[0];
    assert.equal(job.lastRunAt, undefined);
    assert.equal(job.resultSummary, undefined);

    // Cleanup
    await getDb().query("DELETE FROM governance_jobs WHERE dedupe_key LIKE 'gov-job-%'").catch(() => undefined);
  } finally {
    await closeDb().catch(() => undefined);
  }
});

test('governance jobs: runGovernanceSweep with jobTypes filter', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  try {
    await ensureGovernanceJobStore();
    await getDb().query("DELETE FROM governance_jobs WHERE dedupe_key LIKE 'gov-job-%'").catch(() => undefined);
    await seedGovernanceJobs();

    const result = await runGovernanceSweep({
      dryRun: true,
      jobTypes: ['consistency_audit'],
    });
    assert.equal(result.jobsRun, 1);
    assert.equal(result.results[0].jobType, 'consistency_audit');

    await getDb().query("DELETE FROM governance_jobs WHERE dedupe_key LIKE 'gov-job-%'").catch(() => undefined);
  } finally {
    await closeDb().catch(() => undefined);
  }
});
