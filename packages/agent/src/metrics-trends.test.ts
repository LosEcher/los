import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { ensureProviderCallTelemetryStore } from './providers/telemetry.js';
import { getMetricsTrends } from './metrics-trends.js';

test('getMetricsTrends aggregates daily p50/p95 latency, errors, and window compare', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureProviderCallTelemetryStore();

  const stamp = `${Date.now()}`;
  const sessionId = `trend-session-${stamp}`;
  // Current window: [now-2d, now] with two days of data; previous window: two
  // days before that with fewer calls and slower latency.
  const from = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();

  try {
    const insert = (traceId: string, createdAt: string, status: number, durationMs: number, hasUsage: boolean) =>
      getDb().query(
        `INSERT INTO provider_call_telemetry
           (trace_id, session_id, provider, model, endpoint, status, duration_ms, usage_json, created_at)
         VALUES ($1, $2, 'trendprov', 'trend-model', '/chat/completions', $3, $4, $5::jsonb, $6::timestamptz)`,
        [
          traceId,
          sessionId,
          status,
          durationMs,
          JSON.stringify(hasUsage ? { promptTokens: 10, completionTokens: 5 } : {}),
          createdAt,
        ],
      );

    // Previous window (equal length): 1 ok call @2000ms + 1 error.
    await insert(`prev-a-${stamp}`, new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(), 200, 2000, true);
    await insert(`prev-b-${stamp}`, new Date(Date.now() - 3.5 * 24 * 60 * 60 * 1000).toISOString(), 500, 1500, false);
    // Current window day 1: 200ms and 400ms.
    await insert(`cur-a-${stamp}`, new Date(Date.now() - 1.8 * 24 * 60 * 60 * 1000).toISOString(), 200, 200, true);
    await insert(`cur-b-${stamp}`, new Date(Date.now() - 1.5 * 24 * 60 * 60 * 1000).toISOString(), 200, 400, false);
    // Current window day 2: 600ms error + 300ms ok.
    await insert(`cur-c-${stamp}`, new Date(Date.now() - 0.8 * 24 * 60 * 60 * 1000).toISOString(), 503, 600, true);
    await insert(`cur-d-${stamp}`, new Date(Date.now() - 0.2 * 24 * 60 * 60 * 1000).toISOString(), 200, 300, true);

    const trends = await getMetricsTrends({ from, to });
    assert.equal(trends.evidenceClass, 'los_runtime');
    const series = trends.series.find(
      row => row.provider === 'trendprov' && row.model === 'trend-model',
    );
    assert.ok(series!, 'series for trendprov/trend-model exists');
    assert.ok(series!.points.length >= 1, 'at least one daily point in window');

    const totalCalls = series!.points.reduce((sum, p) => sum + p.callCount, 0);
    assert.equal(totalCalls, 4, '4 calls in current window');
    const totalErrors = series!.points.reduce((sum, p) => sum + p.errorCount, 0);
    assert.equal(totalErrors, 1);
    assert.ok(Math.abs(series!.compare.currentErrorRate - 0.25) < 1e-9);

    // Latency percentiles over [200,400,600,300]: p50 in range, p95 >= p50.
    assert.ok(series!.points.every(p => p.p50DurationMs !== null && p.p95DurationMs !== null));
    for (const point of series!.points) {
      assert.ok(point.p50DurationMs! >= 200 && point.p50DurationMs! <= 600,
        `p50 in [200,600], got ${point.p50DurationMs}`);
      assert.ok(point.p95DurationMs! >= point.p50DurationMs!,
        `p95 >= p50, got p50=${point.p50DurationMs} p95=${point.p95DurationMs}`);
    }

    // usage fill: 3 of 4 current calls carry usage (weighted across days).
    const usageCalls = series!.points.reduce(
      (sum, p) => sum + p.callCount * (p.usageFillRate ?? 0),
      0,
    );
    assert.ok(Math.abs(usageCalls - 3) < 1e-9, `usage-filled calls ~3, got ${usageCalls}`);

    // Compare: previous window had 2 calls (1 error, avg 1750ms); current has 4 (avg 375ms).
    assert.equal(series!.compare.previousCalls, 2);
    assert.equal(series!.compare.currentCalls, 4);
    assert.ok(series!.compare.callsDeltaPct !== null);
    assert.ok(Math.abs(series!.compare.callsDeltaPct! - 1) < 1e-9, 'calls doubled');
    assert.ok(Math.abs(series!.compare.previousErrorRate - 0.5) < 1e-9);
    assert.ok(series!.compare.avgMsDeltaPct !== null);
    assert.ok(series!.compare.avgMsDeltaPct! < 0, 'latency improved (negative delta)');
  } finally {
    await getDb().query(
      `DELETE FROM provider_call_telemetry WHERE session_id = $1`,
      [sessionId],
    ).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('getMetricsTrends rejects inverted or oversized windows', async () => {
  await assert.rejects(
    () => getMetricsTrends({ from: '2026-08-09T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' }),
    /from < to/,
  );
  await assert.rejects(
    () => getMetricsTrends({ from: '2026-01-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' }),
    /90 days/,
  );
});
