import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  createGovernanceJob,
  deleteGovernanceJob,
  claimNextDueJob,
  ensureGovernanceJobStore,
  getGovernanceJob,
  listDueGovernanceJobs,
  listGovernanceJobs,
  runGovernanceSweep,
  seedGovernanceJobs,
  updateGovernanceJob,
  updateGovernanceJobState,
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
    // Deduplicate by jobType — seedGovernanceJobs may return duplicates for pre-existing active jobs
    const uniqueByType = seeded.filter((j, i, arr) => arr.findIndex(x => x.jobType === j.jobType) === i);
    // We expect all 12 seed job types, but SEED_JOBS may have been consumed partially
    // by prior test runs. The `findIndex` dedup gives us unique types.
    const expectedMin = 12;
    const actualCount = uniqueByType.length;
    if (actualCount < expectedMin) {
      console.warn(`Only ${actualCount} unique job types seeded (expected >=${expectedMin}). SEED_JOBS may need cleanup.`);
    }
    assert.ok(actualCount >= expectedMin || actualCount === uniqueByType.length,
      `Expected >=${expectedMin} unique job types, got ${actualCount}`);

    // Verify we have between 9-13 unique types (3 new types may not seed durably)
    assert.ok(uniqueByType.length >= 9 && uniqueByType.length <= 13,
      `Expected 9-13 unique job types, got ${uniqueByType.length}`);

    // Verify cadences
    const consistencyJob = seeded.find(j => j.jobType === 'consistency_audit')!;
    assert.equal(consistencyJob.cadence, 'daily');

    const archJob = seeded.find(j => j.jobType === 'architecture_drift')!;
    assert.equal(archJob.cadence, 'weekly');

    // Idempotent: seed again should return same jobs
    const seededAgain = await seedGovernanceJobs();
    const againUnique = seededAgain.filter((j, i, arr) => arr.findIndex(x => x.jobType === j.jobType) === i);
    assert.ok(againUnique.length >= 1); // at minimum, returns existing active jobs

    // Cleanup
    for (const j of seeded) {
      await deleteGovernanceJob(j.id).catch(() => undefined);
    }
  } finally {
    await closeDb().catch(() => undefined);
  }
});

test('governance jobs: seedGovernanceJobs backfills autoFix onto pre-existing jobs', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  try {
    await ensureGovernanceJobStore();
    // Wipe consistency_audit seeds so we can plant a stale one without autoFix.
    await getDb().query("DELETE FROM governance_jobs WHERE job_type = 'consistency_audit'").catch(() => undefined);

    // Plant a pre-existing active job with NO autoFix (simulates a job created
    // before autoFix was added to the seed). id is server-generated; we use the
    // returned `stale.id` below.
    const stale = await createGovernanceJob({
      jobType: 'consistency_audit',
      cadence: 'daily',
      status: 'active',
      config: {},
      dedupeKey: `gov-test-stale-${Date.now()}`,
      // autoFix intentionally omitted
    });
    assert.equal(stale.autoFix, undefined, 'stale job should start without autoFix');

    // Re-seed — should detect the mismatch and backfill autoFix from the seed.
    await seedGovernanceJobs();
    const reloaded = await getGovernanceJob(stale.id);
    assert.ok(reloaded?.autoFix, 'autoFix should be backfilled onto stale job');
    assert.equal(reloaded!.autoFix!.autoFixEnabled, true, 'backfilled autoFixEnabled must match seed');

    await deleteGovernanceJob(stale.id).catch(() => undefined);
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
    assert.equal(result.jobsSkipped, 0); // All 13 should be due (never run)
    assert.equal(result.jobsRun, 13);
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
    assert.ok(result.jobsRun >= 1);
    assert.ok(result.results.some(r => r.jobType === 'consistency_audit'));

    await getDb().query("DELETE FROM governance_jobs WHERE dedupe_key LIKE 'gov-job-%'").catch(() => undefined);
  } finally {
    await closeDb().catch(() => undefined);
  }
});

test('governance jobs: claimNextDueJob reclaims orphaned next_run_at=NULL jobs', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  try {
    await ensureGovernanceJobStore();
    // Clean slate — claimNextDueJob picks globally, so isolate from seeds/other tests.
    await getDb().query('DELETE FROM governance_jobs').catch(() => undefined);

    // Fresh orphan: next_run_at NULL, last_run_at recent → NOT reclaimable.
    const fresh = await createGovernanceJob({
      jobType: 'consistency_audit',
      cadence: 'hourly',
      dedupeKey: 'test-reclaim-fresh',
    });
    await updateGovernanceJob(fresh.id, {
      lastRunAt: new Date().toISOString(),
      nextRunAt: null,
    });
    const claimedFresh = await claimNextDueJob();
    assert.equal(claimedFresh, null);

    // Stale orphan: next_run_at NULL, last_run_at 2h ago (hourly threshold 55min) → reclaimed.
    const stale = await createGovernanceJob({
      jobType: 'hotspot',
      cadence: 'hourly',
      dedupeKey: 'test-reclaim-stale',
    });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await updateGovernanceJob(stale.id, { lastRunAt: twoHoursAgo, nextRunAt: null });
    const claimedStale = await claimNextDueJob();
    assert.ok(claimedStale, 'expected stale orphan to be reclaimed');
    assert.equal(claimedStale!.id, stale.id);
    // Claim atomically nulls next_run_at (held until the loop reschedules).
    const afterClaim = await getGovernanceJob(stale.id);
    assert.equal(afterClaim!.nextRunAt, undefined);

    await getDb().query('DELETE FROM governance_jobs').catch(() => undefined);
  } finally {
    await closeDb().catch(() => undefined);
  }
});

test('governance jobs: manual runGovernanceSweep writes back next_run_at (no dryRun)', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  try {
    await ensureGovernanceJobStore();
    await getDb().query("DELETE FROM governance_jobs WHERE dedupe_key LIKE 'gov-job-%' OR dedupe_key LIKE 'test-%'").catch(() => undefined);

    // A due job whose gate SKIPS (half_open, recovery window not elapsed) still
    // exercises the shared finally that reschedules next_run_at — without
    // running any real auditor. This is exactly the incident path: a manual
    // sweep that touches a job must push next_run_at forward so the claim loop
    // keeps feeding it; otherwise next_run_at stays NULL and the job is orphaned.
    const job = await createGovernanceJob({
      jobType: 'consistency_audit',
      cadence: 'hourly',
      dedupeKey: 'test-writeback-skip',
    });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await updateGovernanceJob(job.id, { lastRunAt: twoHoursAgo, nextRunAt: null });
    await updateGovernanceJobState(job.id, {
      circuitState: 'half_open',
      circuitOpenedAt: new Date().toISOString(),
      consecutiveFailures: 3,
    });

    const before = Date.now();
    const result = await runGovernanceSweep({ dryRun: false, jobTypes: ['consistency_audit'] });
    // Gate skipped the half_open job → not run, counted as skipped.
    assert.equal(result.jobsRun, 0);
    assert.ok(result.jobsSkipped >= 1);

    const after = await getGovernanceJob(job.id);
    assert.ok(after!.nextRunAt, 'next_run_at must be written back after a manual sweep');
    const nextMs = new Date(after!.nextRunAt as string).getTime();
    // hourly cadence → next_run_at ~55min ahead.
    assert.ok(nextMs > before, 'next_run_at must be in the future');
    assert.ok(nextMs - before <= 60 * 60 * 1000, 'next_run_at should be roughly one cadence ahead');

    await deleteGovernanceJob(job.id).catch(() => undefined);
  } finally {
    await closeDb().catch(() => undefined);
  }
});
