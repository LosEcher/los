import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { createRunSpec } from './run-specs.js';
import {
  compareRunEvals,
  ensureRunEvalStore,
  listRunEvals,
  recordFailoverEval,
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

test('run eval comparison reports before and after quality deltas', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `run-eval-compare-${suffix}`;
  const sessionId = `session-run-eval-compare-${suffix}`;
  const baselineAt = '2026-06-01T12:00:00.000Z';
  const candidateAt = '2026-06-02T12:00:00.000Z';

  try {
    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'compare eval quality',
      workspaceRoot: '/tmp/workspace',
      toolMode: 'project-write',
    });
    await ensureRunEvalStore();

    await recordRunEval({
      id: `${runSpecId}-baseline-failure`,
      runSpecId,
      sessionId,
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      success: false,
      latencyMs: 3000,
      retryCount: 2,
      toolErrorCount: 2,
      verificationStatus: 'failed',
      modelCost: 0.3,
      failureClass: 'tool_error',
    });
    await recordRunEval({
      id: `${runSpecId}-baseline-success`,
      runSpecId,
      sessionId,
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      success: true,
      latencyMs: 1000,
      retryCount: 0,
      toolErrorCount: 0,
      verificationStatus: 'succeeded',
      modelCost: 0.1,
    });
    await recordRunEval({
      id: `${runSpecId}-candidate-success-a`,
      runSpecId,
      sessionId,
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      success: true,
      latencyMs: 900,
      retryCount: 0,
      toolErrorCount: 0,
      verificationStatus: 'succeeded',
      modelCost: 0.09,
    });
    await recordRunEval({
      id: `${runSpecId}-candidate-success-b`,
      runSpecId,
      sessionId,
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      success: true,
      latencyMs: 1100,
      retryCount: 0,
      toolErrorCount: 0,
      verificationStatus: 'succeeded',
      modelCost: 0.11,
    });
    await getDb().query(
      `
      UPDATE run_evals
      SET created_at = CASE
        WHEN id LIKE $1 THEN $3::timestamptz
        ELSE $4::timestamptz
      END,
      updated_at = CASE
        WHEN id LIKE $1 THEN $3::timestamptz
        ELSE $4::timestamptz
      END
      WHERE run_spec_id = $2
    `,
      [`${runSpecId}-baseline%`, runSpecId, baselineAt, candidateAt],
    );

    const comparison = await compareRunEvals({
      runSpecId,
      baselineFrom: '2026-06-01T00:00:00.000Z',
      baselineTo: '2026-06-01T23:59:59.999Z',
      candidateFrom: '2026-06-02T00:00:00.000Z',
      candidateTo: '2026-06-02T23:59:59.999Z',
    });

    assert.equal(comparison.baseline.totals.count, 2);
    assert.equal(comparison.candidate.totals.count, 2);
    assert.equal(comparison.baseline.totals.successRate, 0.5);
    assert.equal(comparison.candidate.totals.successRate, 1);
    assert.equal(comparison.delta.successRate, 0.5);
    assert.equal(comparison.delta.failureCount, -1);
    assert.equal(comparison.delta.toolErrorCount, -2);
    assert.equal(comparison.delta.averageLatencyMs, -1000);
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

test('run eval failover scope separates service from executor failures', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `run-eval-failover-${suffix}`;
  const sessionId = `session-run-eval-failover-${suffix}`;

  try {
    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'failover scope eval',
      workspaceRoot: '/tmp/workspace',
      toolMode: 'project-write',
    });
    await ensureRunEvalStore();

    await recordRunEval({
      id: `${runSpecId}-service-fail`,
      runSpecId,
      sessionId,
      success: false,
      latencyMs: 500,
      retryCount: 1,
      toolErrorCount: 0,
      verificationStatus: 'unknown',
      failureClass: 'service_timeout',
      failoverScope: 'service',
    });
    await recordRunEval({
      id: `${runSpecId}-executor-fail`,
      runSpecId,
      sessionId,
      success: false,
      latencyMs: 10000,
      retryCount: 3,
      toolErrorCount: 1,
      verificationStatus: 'unknown',
      failureClass: 'executor_crash',
      failoverScope: 'executor',
    });
    await recordRunEval({
      id: `${runSpecId}-ok`,
      runSpecId,
      sessionId,
      success: true,
      latencyMs: 200,
      retryCount: 0,
      toolErrorCount: 0,
      verificationStatus: 'succeeded',
    });

    const serviceEvals = await listRunEvals({ runSpecId, failoverScope: 'service', limit: 10 });
    assert.equal(serviceEvals.length, 1);
    assert.equal(serviceEvals[0]?.id, `${runSpecId}-service-fail`);

    const execEvals = await listRunEvals({ runSpecId, failoverScope: 'executor', limit: 10 });
    assert.equal(execEvals.length, 1);
    assert.equal(execEvals[0]?.id, `${runSpecId}-executor-fail`);

    const summary = await summarizeRunEvals({ runSpecId, limit: 10 });
    assert.equal(summary.totals.count, 3);
    assert.deepEqual(
      summary.byFailoverScope.map(item => [item.key, item.count]).sort(),
      [['executor', 1], ['service', 1], ['unspecified', 1]],
    );
    const serviceGroup = summary.byFailoverScope.find(item => item.key === 'service')!;
    assert.equal(serviceGroup.failureCount, 1);
    assert.equal(serviceGroup.averageRetryCount, 1);
    const executorGroup = summary.byFailoverScope.find(item => item.key === 'executor')!;
    assert.equal(executorGroup.failureCount, 1);
    assert.equal(executorGroup.averageRetryCount, 3);
  } finally {
    await getDb().query('DELETE FROM run_evals WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('recordFailoverEval auto-records a failover eval with scope', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `run-eval-autofailover-${suffix}`;
  const sessionId = `session-autofailover-${suffix}`;

  try {
    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'auto failover eval',
      workspaceRoot: '/tmp/workspace',
      toolMode: 'project-write',
    });
    await ensureRunEvalStore();

    await recordFailoverEval({
      runSpecId,
      sessionId,
      taskRunId: `task-${suffix}`,
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      failureClass: 'executor_failure',
      failoverScope: 'executor',
      errorMessage: 'Executor http://10.0.0.1:9090 failed with 502',
    });

    const listed = await listRunEvals({ runSpecId, failoverScope: 'executor', limit: 10 });
    assert.equal(listed.length, 1);
    const record = listed[0]!;
    assert.equal(record.success, false);
    assert.equal(record.failoverScope, 'executor');
    assert.equal(record.failureClass, 'executor_failure');
    assert.equal(record.summary.kind, 'failover');

    const serviceListed = await listRunEvals({ runSpecId, failoverScope: 'service', limit: 10 });
    assert.equal(serviceListed.length, 0);

    await recordFailoverEval({
      runSpecId,
      failoverScope: 'service',
      errorMessage: 'DB connection lost',
    });
  } finally {
    await getDb().query('DELETE FROM run_evals WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
