import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { createRunSpec } from './run-specs.js';
import {
  ensureRunEvalStore,
  listRunEvals,
  recordRunEval,
} from './run-evals.js';

test('run evals persist quality metrics for a run spec', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `run-eval-${suffix}`;
  const sessionId = `session-run-eval-${suffix}`;
  const id = `run-eval-record-${suffix}`;

  try {
    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'evaluate run quality',
      workspaceRoot: '/tmp/workspace',
      toolMode: 'project-write',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    });
    await ensureRunEvalStore();

    const created = await recordRunEval({
      id,
      runSpecId,
      sessionId,
      taskRunId: `task-${suffix}`,
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      success: false,
      latencyMs: 1234,
      retryCount: 2,
      toolErrorCount: 1,
      verificationStatus: 'failed',
      modelCost: 0.42,
      userFeedback: 'needs retry evidence',
      failureClass: 'verification_failed',
      summary: { verifier: 'pnpm check' },
    });

    assert.equal(created.id, id);
    assert.equal(created.runSpecId, runSpecId);
    assert.equal(created.success, false);
    assert.equal(created.retryCount, 2);
    assert.equal(created.toolErrorCount, 1);
    assert.equal(created.verificationStatus, 'failed');
    assert.equal(created.failureClass, 'verification_failed');
    assert.deepEqual(created.summary, { verifier: 'pnpm check' });

    const listed = await listRunEvals({
      runSpecId,
      success: false,
      verificationStatus: 'failed',
      failureClass: 'verification_failed',
      limit: 10,
    });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, id);

    const updated = await recordRunEval({
      id,
      runSpecId,
      sessionId,
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      success: true,
      verificationStatus: 'succeeded',
      retryCount: 2,
      toolErrorCount: 0,
      summary: { verifier: 'rerun succeeded' },
    });
    assert.equal(updated.success, true);
    assert.equal(updated.verificationStatus, 'succeeded');
    assert.equal(updated.toolErrorCount, 0);
  } finally {
    await getDb().query('DELETE FROM run_evals WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
