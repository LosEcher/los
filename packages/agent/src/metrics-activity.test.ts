import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { ensureSessionEventStore } from './session-events.js';
import { getMetricsActivity } from './metrics-activity.js';

test('getMetricsActivity buckets concurrent sessions, cost, and drill-down', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureSessionEventStore();

  const stamp = `${Date.now()}`;
  const sessionA = `activity-a-${stamp}`;
  const sessionB = `activity-b-${stamp}`;
  const from = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();

  try {
    const insert = (
      sessionId: string,
      type: string,
      createdAt: string,
      durationMs: number,
      costUsd?: number,
    ) => getDb().query(
      `INSERT INTO session_events
         (session_id, turn, type, source, usage_json, payload_json, created_at)
       VALUES ($1, 1, $2, 'los', '{}'::jsonb, $3::jsonb, $4::timestamptz)`,
      [
        sessionId,
        type,
        JSON.stringify({
          durationMs,
          ...(costUsd !== undefined ? { cost: { totalCostUsd: costUsd } } : {}),
        }),
        createdAt,
      ],
    );

    const hour = 60 * 60 * 1000;
    const t0 = Date.now() - 2.5 * hour; // bucket start for a 1h grid from `from`
    // Session A: two timed events spanning two buckets, 0.1 + 0.2 cost.
    await insert(sessionA, 'model.response', new Date(t0 + 0.2 * hour).toISOString(), 40 * 60 * 1000, 0.1);
    await insert(sessionA, 'tool.result', new Date(t0 + 1.2 * hour).toISOString(), 30 * 60 * 1000);
    // Session B: overlaps A in the first bucket (concurrency 2), 0.3 cost.
    await insert(sessionB, 'model.response', new Date(t0 + 0.5 * hour).toISOString(), 20 * 60 * 1000, 0.3);

    const activity = await getMetricsActivity({ from, to, bucketMinutes: 60 });
    assert.equal(activity.evidenceClass, 'los_runtime');
    assert.equal(activity.bucketSizeMinutes, 60);
    assert.ok(activity.buckets.length >= 1, 'has buckets');
    assert.ok(activity.totals.peakConcurrent >= 2, `peak concurrency >= 2, got ${activity.totals.peakConcurrent}`);
    assert.ok(activity.totals.totalCostUsd >= 0.4, `total cost >= 0.4, got ${activity.totals.totalCostUsd}`);
    assert.ok(activity.totals.totalAgentMinutes >= 60, `agent-minutes >= 60, got ${activity.totals.totalAgentMinutes}`);

    // Drill-down: first bucket contains both sessions.
    const firstBucket = activity.buckets[0]!.bucket;
    const drilldown = await getMetricsActivity({ from, to, bucketMinutes: 60, bucket: firstBucket });
    assert.ok(drilldown.drilldown, 'drilldown present');
    assert.ok(drilldown.drilldown!.length >= 1, 'drilldown has sessions');
    assert.ok(
      drilldown.drilldown!.some(row => row.sessionId === sessionA),
      'session A in first bucket',
    );
    const aRow = drilldown.drilldown!.find(row => row.sessionId === sessionA);
    assert.ok(aRow && aRow.eventCount >= 1, 'session A has timed events');
    assert.ok(aRow!.estimatedCostUsd >= 0.1, 'session A cost attributed');
  } finally {
    await getDb().query(
      `DELETE FROM session_events WHERE session_id IN ($1, $2)`,
      [sessionA, sessionB],
    ).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('getMetricsActivity rejects inverted windows and bad buckets', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  try {
    await assert.rejects(
      () => getMetricsActivity({ from: '2026-08-09T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' }),
      /from < to/,
    );
    await assert.rejects(
      () => getMetricsActivity({ from: '2026-01-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' }),
      /90 days/,
    );
    await assert.rejects(
      () => getMetricsActivity({ bucket: 'not-a-date' }),
      /valid ISO timestamp/,
    );
  } finally {
    await closeDb().catch(() => undefined);
  }
});
