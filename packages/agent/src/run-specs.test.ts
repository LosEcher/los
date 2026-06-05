import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { createRunSpec, ensureRunSpecStore, loadRunSpec } from './run-specs.js';
import { listVerificationRecordsForRunSpec } from './verification-records.js';

test('run specs persist normalized run contract metadata', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const id = `run-contract-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await ensureRunSpecStore();
    const created = await createRunSpec({
      id,
      sessionId: `session-${id}`,
      prompt: 'inspect run contract metadata',
      workspaceRoot: '/tmp/workspace',
      toolMode: 'project-write',
      runContract: {
        mode: 'execution',
        goal: 'persist run spec contract',
        editableSurfaces: ['packages/agent/src/run-specs.ts'],
        requiredChecks: ['pnpm --filter @los/agent test'],
        stopConditions: ['auth mutation'],
        evidenceRequired: ['run_specs row'],
        rawEvidenceProhibited: ['raw transcript'],
      },
    });

    assert.deepEqual(created.runContract, {
      mode: 'execution',
      goal: 'persist run spec contract',
      editableSurfaces: ['packages/agent/src/run-specs.ts'],
      requiredChecks: ['pnpm --filter @los/agent test'],
      allowedSkippedChecks: [],
      stopConditions: ['auth mutation'],
      evidenceRequired: ['run_specs row'],
      externalEvidenceAllowed: [],
      rawEvidenceProhibited: ['raw transcript'],
    });

    const loaded = await loadRunSpec(id);
    assert.equal(loaded?.runContract?.mode, 'execution');
    assert.deepEqual(loaded?.runContract?.evidenceRequired, ['run_specs row']);

    const checks = await listVerificationRecordsForRunSpec(id);
    assert.deepEqual(checks.map((check) => check.checkName), ['pnpm --filter @los/agent test']);
    assert.ok(checks.every((check) => check.status === 'required'));
  } finally {
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [id]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [id]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
