import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { createRunSpec } from './run-specs.js';
import {
  ensureRunEvalStore,
  listRunEvals,
  recordRunEval,
  summarizeRunEvals,
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

test('run eval summaries group failure causes and quality metrics', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `run-eval-summary-${suffix}`;
  const sessionId = `session-run-eval-summary-${suffix}`;

  try {
    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'summarize eval quality',
      workspaceRoot: '/tmp/workspace',
      toolMode: 'project-write',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    });
    await ensureRunEvalStore();

    await recordRunEval({
      id: `${runSpecId}-failed-tool`,
      runSpecId,
      sessionId,
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      success: false,
      latencyMs: 1000,
      retryCount: 1,
      toolErrorCount: 2,
      verificationStatus: 'failed',
      modelCost: 0.1,
      failureClass: 'tool_error',
    });
    await recordRunEval({
      id: `${runSpecId}-failed-verifier`,
      runSpecId,
      sessionId,
      provider: 'openai',
      model: 'gpt-test',
      success: false,
      latencyMs: 3000,
      retryCount: 2,
      toolErrorCount: 0,
      verificationStatus: 'failed',
      modelCost: 0.3,
      failureClass: 'verification_failed',
    });
    await recordRunEval({
      id: `${runSpecId}-success`,
      runSpecId,
      sessionId,
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      success: true,
      latencyMs: 2000,
      retryCount: 0,
      toolErrorCount: 0,
      verificationStatus: 'succeeded',
      modelCost: 0.2,
    });

    const summary = await summarizeRunEvals({ runSpecId, limit: 10 });
    assert.equal(summary.totals.count, 3);
    assert.equal(summary.totals.successCount, 1);
    assert.equal(summary.totals.failureCount, 2);
    assert.equal(summary.totals.successRate, 1 / 3);
    assert.equal(summary.totals.averageLatencyMs, 2000);
    assert.equal(summary.totals.averageRetryCount, 1);
    assert.equal(summary.totals.toolErrorCount, 2);
    assert.equal(summary.totals.modelCost, 0.6);
    assert.deepEqual(
      summary.byFailureClass.map(item => [item.key, item.count]).sort(),
      [['tool_error', 1], ['verification_failed', 1]],
    );
    assert.deepEqual(
      summary.byVerificationStatus.map(item => [item.key, item.count]).sort(),
      [['failed', 2], ['succeeded', 1]],
    );
    assert.ok(summary.byProviderModel.some(item => item.key === 'deepseek:deepseek-v4-pro' && item.count === 2));
  } finally {
    await getDb().query('DELETE FROM run_evals WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
