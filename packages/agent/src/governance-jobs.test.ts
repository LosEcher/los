import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  ensureGovernanceJobStore,
  upsertGovernanceJob,
  listDueGovernanceJobs,
  recordGovernanceJobRun,
  seedGovernanceJobs,
  listGovernanceJobs,
} from './governance-jobs.js';

test('upsertGovernanceJob creates a job record', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  try {
    const job = await upsertGovernanceJob({
      jobType: 'consistency_audit',
      cadence: 'manual',
      config: { rules: ['los.state-machine-bypass'] },
    });

    assert.equal(job.jobType, 'consistency_audit');
    assert.equal(job.cadence, 'manual');
    assert.deepEqual(job.config, { rules: ['los.state-machine-bypass'] });
  } finally {
    await closeDb().catch(() => undefined);
  }
});

test('listDueGovernanceJobs returns manual and overdue jobs', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  try {
    await ensureGovernanceJobStore();

    // Manual job should always be due
    await upsertGovernanceJob({ id: 'test-manual', jobType: 'hotspot', cadence: 'manual' });

    const due = await listDueGovernanceJobs();
    const manualJob = due.find(j => j.id === 'test-manual');
    assert.ok(manualJob);
  } finally {
    await getDb().query('DELETE FROM governance_jobs WHERE id = $1', ['test-manual']).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('recordGovernanceJobRun records result summary', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  try {
    const job = await upsertGovernanceJob({
      jobType: 'architecture_drift',
      cadence: 'manual',
    });

    const taskRunId = 'test-task-run-1';
    const updated = await recordGovernanceJobRun(job.id, taskRunId, {
      status: 'pass',
      counts: { findings: 3 },
      findings: 3,
    });

    assert.ok(updated);
    assert.equal(updated.lastTaskRunId, taskRunId);
    assert.equal(updated.resultSummary?.status, 'pass');
    assert.equal(updated.resultSummary?.findings, 3);
    assert.ok(updated.lastRunAt);
  } finally {
    await closeDb().catch(() => undefined);
  }
});

test('seedGovernanceJobs creates all default jobs', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  try {
    const jobs = await seedGovernanceJobs();
    assert.ok(jobs.length >= 4, `expected >= 4 seed jobs, got ${jobs.length}`);

    const types = new Set(jobs.map(j => j.jobType));
    assert.ok(types.has('consistency_audit'));
    assert.ok(types.has('hotspot'));
    assert.ok(types.has('architecture_drift'));
    assert.ok(types.has('provider_surveillance'));
  } finally {
    await getDb().query('DELETE FROM governance_jobs WHERE id LIKE $1', ['govjob-%']).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('listGovernanceJobs filters by type', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  try {
    await upsertGovernanceJob({ id: 'test-type-hotspot', jobType: 'hotspot', cadence: 'manual' });
    await upsertGovernanceJob({ id: 'test-type-audit', jobType: 'consistency_audit', cadence: 'manual' });

    const hotspots = await listGovernanceJobs({ jobType: 'hotspot' });
    assert.ok(hotspots.every(j => j.jobType === 'hotspot'));
    assert.ok(hotspots.length >= 1);
  } finally {
    await getDb().query('DELETE FROM governance_jobs WHERE id IN ($1, $2)', ['test-type-hotspot', 'test-type-audit']).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
