import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { ensureProviderCallTelemetryStore } from './providers/telemetry.js';
import { getUsageSummary } from './usage-summary.js';

test('getUsageSummary aggregates model.response cost and tokens by provider/model', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureProviderCallTelemetryStore();

  const stamp = `${Date.now()}`;
  const sessionId = `usage-session-${stamp}`;
  const from = new Date(Date.now() - 60_000).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();

  try {
    await getDb().query(
      `INSERT INTO session_events (
         session_id, type, model, usage_json, payload_json, source, created_at
       ) VALUES
         ($1, 'model.response', 'deepseek-v4-flash',
          $2::jsonb, $3::jsonb, 'los', now()),
         ($1, 'model.response', 'deepseek-v4-flash',
          $4::jsonb, $5::jsonb, 'los', now())`,
      [
        sessionId,
        JSON.stringify({
          promptTokens: 100,
          completionTokens: 20,
          cacheHitTokens: 40,
          cacheMissTokens: 60,
          totalTokens: 120,
        }),
        JSON.stringify({
          provider: 'deepseek',
          cost: { totalCostUsd: 0.01, cacheSavingsUsd: 0.002 },
        }),
        JSON.stringify({
          promptTokens: 50,
          completionTokens: 10,
          cacheHitTokens: 10,
          cacheMissTokens: 40,
          totalTokens: 60,
        }),
        JSON.stringify({
          provider: 'deepseek',
          cost: { totalCostUsd: 0.005, cacheSavingsUsd: 0.001 },
        }),
      ],
    );

    await getDb().query(
      `INSERT INTO provider_call_telemetry
         (trace_id, session_id, provider, model, endpoint, status, duration_ms, usage_json)
       VALUES
         ($1, $2, 'deepseek', 'deepseek-v4-flash', '/chat/completions', 200, 150,
          $3::jsonb),
         ($4, $2, 'deepseek', 'deepseek-v4-flash', '/chat/completions', 200, 250,
          '{}'::jsonb)`,
      [
        `usage-trace-a-${stamp}`,
        sessionId,
        JSON.stringify({ promptTokens: 100, completionTokens: 20 }),
        `usage-trace-b-${stamp}`,
      ],
    );

    const summary = await getUsageSummary({ from, to, provider: 'deepseek' });
    assert.equal(summary.evidenceClass, 'los_runtime');
    assert.equal(summary.totals.modelResponseCount, 2);
    assert.equal(summary.totals.sessionCount, 1);
    assert.equal(summary.totals.promptTokens, 150);
    assert.equal(summary.totals.completionTokens, 30);
    assert.equal(summary.totals.cacheHitTokens, 50);
    assert.equal(summary.totals.cacheMissTokens, 100);
    assert.ok(Math.abs(summary.totals.estimatedCostUsd - 0.015) < 1e-9);
    assert.ok(Math.abs(summary.totals.cacheSavingsUsd - 0.003) < 1e-9);
    assert.ok(summary.totals.cacheHitRate !== null);
    assert.ok(Math.abs((summary.totals.cacheHitRate ?? 0) - 50 / 150) < 1e-9);

    assert.equal(summary.byProviderModel.length, 1);
    assert.equal(summary.byProviderModel[0]?.provider, 'deepseek');
    assert.equal(summary.byProviderModel[0]?.model, 'deepseek-v4-flash');

    assert.ok(summary.byDay.length >= 1);
    const call = summary.callTelemetry.find(
      row => row.provider === 'deepseek' && row.model === 'deepseek-v4-flash',
    );
    assert.ok(call);
    assert.equal(call!.callCount, 2);
    assert.equal(call!.withUsageCount, 1);
    assert.ok(call!.usageFillRate !== null);
    assert.ok(Math.abs((call!.usageFillRate ?? 0) - 0.5) < 1e-9);

    // Roadmap R6: feature attribution. The two inserted telemetry rows carry
    // no request_meta_json → 'unspecified'; a chat-tagged row must group
    // under 'chat' with its trace-joined cost.
    await getDb().query(
      `INSERT INTO provider_call_telemetry
         (trace_id, session_id, provider, model, endpoint, status, duration_ms, usage_json, request_meta_json)
       VALUES
         ($1, $2, 'deepseek', 'deepseek-v4-flash', '/chat/completions', 200, 100,
          $3::jsonb, $4::jsonb)`,
      [
        `usage-trace-c-${stamp}`,
        sessionId,
        JSON.stringify({ promptTokens: 30, completionTokens: 5 }),
        JSON.stringify({ feature: 'chat', reasoningEffort: 'high' }),
      ],
    );
    await getDb().query(
      `INSERT INTO session_events (
         session_id, type, model, usage_json, payload_json, source, trace_id, created_at
       ) VALUES ($1, 'model.response', 'deepseek-v4-flash',
         $2::jsonb, $3::jsonb, 'los', $4, now())`,
      [
        sessionId,
        JSON.stringify({ promptTokens: 30, completionTokens: 5, totalTokens: 35 }),
        JSON.stringify({ provider: 'deepseek', cost: { totalCostUsd: 0.002 } }),
        `usage-trace-c-${stamp}`,
      ],
    );

    const summary2 = await getUsageSummary({ from, to, provider: 'deepseek' });
    const chatRow = summary2.byFeature.find(row => row.feature === 'chat');
    assert.ok(chatRow, 'byFeature contains chat');
    assert.equal(chatRow!.callCount, 1);
    assert.equal(chatRow!.promptTokens, 30);
    assert.ok(Math.abs((chatRow!.estimatedCostUsd ?? 0) - 0.002) < 1e-9);
    const unspecifiedRow = summary2.byFeature.find(row => row.feature === 'unspecified');
    assert.ok(unspecifiedRow, 'byFeature contains unspecified for pre-R6 rows');
    assert.equal(unspecifiedRow!.callCount, 2);
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query(
      `DELETE FROM provider_call_telemetry WHERE session_id = $1`,
      [sessionId],
    ).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('getUsageSummary rejects inverted or oversized windows', async () => {
  await assert.rejects(
    () => getUsageSummary({ from: '2026-08-09T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' }),
    /from < to/,
  );
  await assert.rejects(
    () => getUsageSummary({ from: '2026-01-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' }),
    /90 days/,
  );
});
