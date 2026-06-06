import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  createVerificationRecord,
  ensureVerificationRecordStore,
  listVerificationRecordsForRunSpec,
  loadVerificationRecord,
  seedVerificationRequirementsForRunSpec,
  updateVerificationRecord,
} from './verification-records.js';
import { createRunSpec, loadRunSpec, updateRunSpecStatus } from './run-specs.js';
import { listSessionEvents } from './session-events.js';
import { runVerificationRecordsForRunSpec } from './verification-runner.js';

test('verification records track required, succeeded, and skipped checks', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-verification-${suffix}`;
  const runSpecId = `run-verification-${suffix}`;
  try {
    await ensureVerificationRecordStore();
    await seedVerificationRequirementsForRunSpec({
      sessionId,
      runSpecId,
      requiredChecks: ['pnpm check', 'pnpm check', 'pnpm test'],
    });
    const seeded = await listVerificationRecordsForRunSpec(runSpecId);
    assert.deepEqual(seeded.map((item) => item.checkName), ['pnpm check', 'pnpm test']);
    assert.ok(seeded.every((item) => item.status === 'required'));

    const succeeded = await updateVerificationRecord(seeded[0]!.id, {
      status: 'succeeded',
      outputSummary: 'ok',
    });
    assert.equal(succeeded?.status, 'succeeded');
    assert.equal(succeeded?.outputSummary, 'ok');
    assert.ok(succeeded?.completedAt);

    const skipped = await createVerificationRecord({
      id: `verification-skip-${suffix}`,
      sessionId,
      runSpecId,
      checkName: 'browser smoke',
      status: 'skipped',
      required: false,
      skipReason: 'docs-only change',
    });
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.skipReason, 'docs-only change');
    assert.ok(skipped.completedAt);
  } finally {
    await getDb().query('DELETE FROM verification_records WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('verification runner executes required checks and releases blocked run specs', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-verifier-runner-${suffix}`;
  const runSpecId = `run-verifier-runner-${suffix}`;
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('verify ok')")}`;
  try {
    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'run verifier',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      runContract: {
        mode: 'closeout',
        requiredChecks: [command],
      },
    });
    await updateRunSpecStatus(runSpecId, 'blocked');

    const result = await runVerificationRecordsForRunSpec(runSpecId, {
      timeoutMs: 5_000,
      outputLimit: 1_000,
    });

    assert.equal(result.decision.status, 'succeeded');
    assert.equal(result.ranRecordIds.length, 1);
    assert.equal(result.records[0]?.status, 'succeeded');
    assert.match(result.records[0]?.outputSummary ?? '', /verify ok/);
    assert.equal((await loadRunSpec(runSpecId))?.status, 'succeeded');

    const loaded = await loadVerificationRecord(result.records[0]!.id);
    assert.equal(loaded?.completedAt !== undefined, true);

    const events = await listSessionEvents(sessionId, 100);
    assert.ok(events.some(event => event.type === 'verification.running'));
    assert.ok(events.some(event => event.type === 'verification.succeeded'));
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('verification runner keeps required failed checks blocking completion', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-verifier-fail-${suffix}`;
  const runSpecId = `run-verifier-fail-${suffix}`;
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.error('verify failed'); process.exit(7)")}`;
  try {
    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'run verifier failure',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      runContract: {
        mode: 'closeout',
        requiredChecks: [command],
      },
    });

    const result = await runVerificationRecordsForRunSpec(runSpecId, {
      timeoutMs: 5_000,
      outputLimit: 1_000,
    });

    assert.equal(result.decision.status, 'blocked');
    assert.equal(result.decision.failedVerificationRecordIds.length, 1);
    assert.equal(result.records[0]?.status, 'failed');
    assert.match(result.records[0]?.outputSummary ?? '', /verify failed/);
    assert.match(result.records[0]?.error ?? '', /exited with 7/);
    assert.equal((await loadRunSpec(runSpecId))?.status, 'blocked');
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
