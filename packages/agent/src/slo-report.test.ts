import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { buildSloReport } from './slo-report.js';
import { ensureTaskRunStore } from './task-runs.js';

test('slo report aggregates completion, intervention, recovery and latency by provider/model/kernel', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const now = Date.now();
  try {
    await ensureTaskRunStore();
    const rows = [
      // 4 succeeded, 1 blocked, 1 failed, 1 cancelled — completion 4/6, intervention 1/7
      { status: 'succeeded', provider: 'deepseek', model: 'flash', attempt: 1, startedMs: now - 10_000, doneMs: now - 5_000 },
      { status: 'succeeded', provider: 'deepseek', model: 'flash', attempt: 1, startedMs: now - 20_000, doneMs: now - 15_000 },
      { status: 'succeeded', provider: 'deepseek', model: 'flash', attempt: 2, startedMs: now - 60_000, doneMs: now - 10_000 }, // recovered
      { status: 'succeeded', provider: 'deepseek', model: 'flash', attempt: 2, startedMs: now - 80_000, doneMs: now - 30_000 }, // recovered
      { status: 'blocked', provider: 'deepseek', model: 'flash', attempt: 1, startedMs: now - 5_000, doneMs: null },
      { status: 'failed', provider: 'deepseek', model: 'flash', attempt: 1, startedMs: now - 4_000, doneMs: now - 2_000 },
      { status: 'cancelled', provider: 'deepseek', model: 'flash', attempt: 1, startedMs: now - 3_000, doneMs: null },
      // different model group
      { status: 'succeeded', provider: 'xai', model: 'grok-4.5', attempt: 1, startedMs: now - 30_000, doneMs: now - 20_000 },
    ];
    for (const [i, r] of rows.entries()) {
      const taskRunId = `run-slo-${suffix}-${i}`;
      await getDb().query(
        `INSERT INTO task_runs
           (id, session_id, trace_id, workspace_root, tool_mode, provider, model, status, attempt, created_at, updated_at, started_at, completed_at, metadata_json)
         VALUES ($1, $2, $3, '/', 'read-only', $4, $5, $6, $7, $8, $8, $9, $10, '{}'::jsonb)`,
        [
          taskRunId,
          `session-slo-${suffix}`,
          `trace-slo-${suffix}-${i}`,
          r.provider,
          r.model,
          r.status,
          r.attempt,
          new Date(now - 120_000).toISOString(),
          r.startedMs !== null ? new Date(r.startedMs).toISOString() : null,
          r.doneMs !== null ? new Date(r.doneMs).toISOString() : null,
        ],
      );
    }

    const report = await buildSloReport({ windowDays: 7 });
    assert.equal(report.windowDays, 7);
    assert.ok(report.generatedAt);

    const flash = report.groups.find((g) => g.provider === 'deepseek' && g.model === 'flash');
    assert.ok(flash, 'deepseek/flash group exists');
    assert.equal(flash.runs, 7);
    assert.equal(flash.succeeded, 4);
    assert.equal(flash.blocked, 1);
    assert.equal(flash.failed, 1);
    assert.equal(flash.cancelled, 1);
    assert.equal(flash.completionRate, 4 / 6);
    assert.equal(flash.interventionRate, 1 / 7);
    assert.equal(flash.recoveryAttempts, 2);
    assert.equal(flash.recoverySucceeded, 2);
    assert.equal(flash.recoveryRate, 1);
    assert.ok(flash.p50DurationMs !== null && flash.p50DurationMs > 0);
    assert.ok(flash.p95DurationMs !== null && flash.p95DurationMs >= flash.p50DurationMs);

    const grok = report.groups.find((g) => g.provider === 'xai' && g.model === 'grok-4.5');
    assert.ok(grok);
    assert.equal(grok.runs, 1);
    assert.equal(grok.completionRate, 1);

    // default kernel when metadata is absent
    assert.equal(flash.kernel, 'los');
  } finally {
    await getDb().query('DELETE FROM task_runs WHERE session_id = $1', [`session-slo-${suffix}`]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('slo report honors windowDays bounds', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  try {
    const report = await buildSloReport({ windowDays: 999 });
    assert.equal(report.windowDays, 90);
    const clamped = await buildSloReport({ windowDays: 0 });
    assert.equal(clamped.windowDays, 1);
  } finally {
    await closeDb().catch(() => undefined);
  }
});
