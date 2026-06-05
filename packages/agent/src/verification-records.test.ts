import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  createVerificationRecord,
  ensureVerificationRecordStore,
  listVerificationRecordsForRunSpec,
  seedVerificationRequirementsForRunSpec,
  updateVerificationRecord,
} from './verification-records.js';

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
