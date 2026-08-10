import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { ensureScheduledWorkStore } from './scheduled-work/schema.js';
import { formatDailyDigestMessage, getDailyDigest, publishDailyDigest } from './daily-digest.js';

test('getDailyDigest aggregates schedules and emits cadence recommendations', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureScheduledWorkStore();

  const day = '2026-08-08';
  const stamp = `${Date.now()}`;
  const readinessId = `schedule-digest-ready-${stamp}`;
  const freshnessId = `schedule-digest-fresh-${stamp}`;
  const analysisId = `schedule-digest-analysis-${stamp}`;
  const runIds = [
    `schedule-run-digest-a-${stamp}`,
    `schedule-run-digest-b-${stamp}`,
    `schedule-run-digest-c-${stamp}`,
  ];

  try {
    await getDb().query(
      `INSERT INTO scheduled_work_items (
         id, tenant_id, project_id, title, status, trigger_json, run_template_json,
         approval_policy, approval_timeout_ms, approval_timeout_action,
         concurrency_policy, catch_up_policy, max_concurrent_runs, max_lateness_ms,
         max_attempts, retry_backoff_ms, failure_threshold, next_run_at, circuit_state,
         consecutive_failures, consecutive_no_ops, revision, metadata_json
       ) VALUES
       ($1,'local','los','dogfood runtime readiness check','enabled',
        $4::jsonb, $5::jsonb, 'read_only_auto', 600000, 'deny',
        'skip','skip',1,3600000,1,0,3, now(), 'closed', 0, 0, 1, '{}'::jsonb),
       ($2,'local','los','observability: gateway/executor log freshness check (V3)','enabled',
        $6::jsonb, $5::jsonb, 'read_only_auto', 600000, 'deny',
        'skip','skip',1,3600000,1,0,3, now(), 'closed', 0, 0, 1, '{}'::jsonb),
       ($3,'local','los','surge log error analysis (6h) v4','enabled',
        $7::jsonb, $8::jsonb, 'each_run', 600000, 'deny',
        'skip','skip',1,3600000,1,0,3, now(), 'closed', 0, 0, 1, '{}'::jsonb)`,
      [
        readinessId,
        freshnessId,
        analysisId,
        JSON.stringify({ kind: 'interval', expression: '5m', timezone: 'Asia/Shanghai' }),
        JSON.stringify({
          templateId: 'runtime_readiness',
          mode: 'governance',
          goalTemplate: 'readiness',
          editableSurfaces: [],
          requiredChecks: [],
          toolMode: 'read-only',
        }),
        JSON.stringify({ kind: 'interval', expression: '10m', timezone: 'Asia/Shanghai' }),
        JSON.stringify({ kind: 'interval', expression: '6h', timezone: 'Asia/Shanghai' }),
        JSON.stringify({
          templateId: 'scheduled_execution',
          mode: 'execution',
          goalTemplate: 'analyze',
          editableSurfaces: [],
          requiredChecks: [],
          toolMode: 'read-only',
        }),
      ],
    );

    await getDb().query(
      `INSERT INTO scheduled_work_item_runs (
         id, schedule_id, scheduled_for, trigger_kind, status, attempt_count, max_attempts,
         result_summary_json, started_at, completed_at
       ) VALUES
       ($1, $4, $7::timestamptz, 'scheduled', 'succeeded', 1, 1, '{}'::jsonb, $7::timestamptz, $7::timestamptz),
       ($2, $5, $7::timestamptz, 'scheduled', 'succeeded', 1, 1, '{}'::jsonb, $7::timestamptz, $7::timestamptz),
       ($3, $6, $7::timestamptz, 'scheduled', 'cancelled', 1, 1,
         $8::jsonb, $7::timestamptz, $7::timestamptz)`,
      [
        runIds[0],
        runIds[1],
        runIds[2],
        readinessId,
        freshnessId,
        analysisId,
        `${day}T12:00:00.000Z`,
        JSON.stringify({ deniedBy: 'auto:approval_timeout', deniedReason: 'approval_timeout' }),
      ],
    );

    await getDb().query(
      `INSERT INTO session_events (
         session_id, type, model, usage_json, payload_json, source, created_at
       ) VALUES ($1, 'model.response', 'deepseek-v4-flash', $2::jsonb, $3::jsonb, 'los', $4::timestamptz)`,
      [
        `digest-session-${stamp}`,
        JSON.stringify({ promptTokens: 10, completionTokens: 2, cacheHitTokens: 4, cacheMissTokens: 6 }),
        JSON.stringify({ provider: 'deepseek', cost: { totalCostUsd: 0.001, cacheSavingsUsd: 0.0002 } }),
        `${day}T15:00:00.000Z`,
      ],
    );

    const digest = await getDailyDigest({ day, projectId: 'los' });
    assert.equal(digest.evidenceClass, 'los_runtime');
    assert.equal(digest.day, day);
    assert.ok(digest.schedule.runTotals.runCount >= 3);
    assert.ok(digest.schedule.bySchedule.some(row => row.scheduleId === readinessId));
    assert.ok(digest.usage.totals.modelResponseCount >= 1);
    assert.ok(digest.highlights.length >= 2);

    const reduceReady = digest.cadenceRecommendations.find(
      r => r.scheduleId === readinessId && r.action === 'reduce_frequency',
    );
    assert.ok(reduceReady);
    assert.equal(reduceReady!.recommendedExpression, '15m');

    const reduceFresh = digest.cadenceRecommendations.find(
      r => r.scheduleId === freshnessId && r.action === 'reduce_frequency',
    );
    assert.ok(reduceFresh);
    assert.equal(reduceFresh!.recommendedExpression, '30m');

    const fixApproval = digest.cadenceRecommendations.find(
      r => r.scheduleId === analysisId && r.action === 'fix_approval_policy',
    );
    assert.ok(fixApproval);
  } finally {
    await getDb().query('DELETE FROM scheduled_work_item_runs WHERE id = ANY($1::text[])', [runIds]).catch(() => undefined);
    await getDb().query(
      'DELETE FROM scheduled_work_items WHERE id = ANY($1::text[])',
      [[readinessId, freshnessId, analysisId]],
    ).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [`digest-session-${stamp}`]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('getDailyDigest rejects invalid day', async () => {
  await assert.rejects(() => getDailyDigest({ day: '08-09-2026' }), /YYYY-MM-DD/);
});

test('formatDailyDigestMessage is Chinese and mobile-readable', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  try {
    const day = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const digest = await getDailyDigest({ day, projectId: 'los' });
    const text = formatDailyDigestMessage(digest);
    assert.match(text, new RegExp(day));
    assert.match(text, /执行日报/);
    assert.match(text, /【总览】/);
    assert.match(text, /【任务明细】|【模型用量】/);
    assert.match(text, /#usage\?day=/);
    assert.doesNotMatch(text, /\bn=\d+/);
    assert.doesNotMatch(text, /\bok=\d+/);
    assert.doesNotMatch(text, /cache_hit_rate=/);
    assert.ok(text.length > 40);
  } finally {
    await closeDb().catch(() => undefined);
  }
});

test('publishDailyDigest dryRun skips session event', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  try {
    const day = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const result = await publishDailyDigest({ day, projectId: 'los' }, { dryRun: true });
    assert.equal(result.eventEmitted, false);
    assert.equal(result.digest.day, day);
    assert.match(result.message, /执行日报/);
  } finally {
    await closeDb().catch(() => undefined);
  }
});
