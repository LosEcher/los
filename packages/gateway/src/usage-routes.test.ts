import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { registerRequestContext } from './request-context.js';
import { registerUsageRoutes } from './routes/infrastructure/usage-routes.js';

test('GET /usage/summary returns L1 runtime cube from session_events', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const app = Fastify({ logger: false });
  registerRequestContext(app, config);
  registerUsageRoutes(app);

  const stamp = `${Date.now()}`;
  const sessionId = `usage-route-session-${stamp}`;
  try {
    await getDb().query(
      `INSERT INTO session_events (
         session_id, type, model, usage_json, payload_json, source, created_at
       ) VALUES ($1, 'model.response', 'deepseek-v4-flash', $2::jsonb, $3::jsonb, 'los', now())`,
      [
        sessionId,
        JSON.stringify({ promptTokens: 10, completionTokens: 5, cacheHitTokens: 2, cacheMissTokens: 8 }),
        JSON.stringify({ provider: 'deepseek', cost: { totalCostUsd: 0.001, cacheSavingsUsd: 0.0001 } }),
      ],
    );

    const response = await app.inject({
      method: 'GET',
      url: `/usage/summary?from=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}&provider=deepseek`,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      evidenceClass: string;
      totals: { modelResponseCount: number; promptTokens: number; estimatedCostUsd: number };
      byProviderModel: Array<{ provider: string; model: string }>;
    };
    assert.equal(body.evidenceClass, 'los_runtime');
    assert.ok(body.totals.modelResponseCount >= 1);
    assert.ok(body.totals.promptTokens >= 10);
    assert.ok(body.byProviderModel.some(row => row.provider === 'deepseek'));
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
    await app.close();
  }
});

test('GET /usage/summary returns 400 for invalid window', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const app = Fastify({ logger: false });
  registerRequestContext(app, config);
  registerUsageRoutes(app);
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/usage/summary?from=2026-08-09T00:00:00.000Z&to=2026-08-01T00:00:00.000Z',
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'invalid_usage_query');
  } finally {
    await closeDb().catch(() => undefined);
    await app.close();
  }
});

test('GET /ops/daily-digest returns composed L1 digest', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const app = Fastify({ logger: false });
  registerRequestContext(app, config);
  registerUsageRoutes(app);
  try {
    const day = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const response = await app.inject({
      method: 'GET',
      url: `/ops/daily-digest?day=${day}&projectId=los`,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      evidenceClass: string;
      day: string;
      schedule: { runTotals: { runCount: number } };
      usage: { totals: { modelResponseCount: number } };
      cadenceRecommendations: unknown[];
      highlights: string[];
    };
    assert.equal(body.evidenceClass, 'los_runtime');
    assert.equal(body.day, day);
    assert.ok(Array.isArray(body.cadenceRecommendations));
    assert.ok(Array.isArray(body.highlights));
    assert.ok(typeof body.schedule.runTotals.runCount === 'number');
    assert.ok(typeof body.usage.totals.modelResponseCount === 'number');
  } finally {
    await closeDb().catch(() => undefined);
    await app.close();
  }
});

test('GET /ops/daily-digest returns 400 for invalid day', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const app = Fastify({ logger: false });
  registerRequestContext(app, config);
  registerUsageRoutes(app);
  try {
    const response = await app.inject({ method: 'GET', url: '/ops/daily-digest?day=not-a-day' });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'invalid_daily_digest_query');
  } finally {
    await closeDb().catch(() => undefined);
    await app.close();
  }
});

test('POST /ops/daily-digest/push emits digest event envelope', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const app = Fastify({ logger: false });
  registerRequestContext(app, config);
  registerUsageRoutes(app);
  try {
    const day = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const response = await app.inject({
      method: 'POST',
      url: '/ops/daily-digest/push',
      payload: { day, projectId: 'los' },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      ok: boolean;
      day: string;
      eventEmitted: boolean;
      messagePreview: string;
    };
    assert.equal(body.ok, true);
    assert.equal(body.day, day);
    assert.equal(body.eventEmitted, true);
    assert.match(body.messagePreview, /执行日报|执行汇总/);
  } finally {
    await closeDb().catch(() => undefined);
    await app.close();
  }
});

test('GET /ops/runtime-health returns synthesizer board', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const app = Fastify({ logger: false });
  registerRequestContext(app, config);
  registerUsageRoutes(app);
  try {
    const response = await app.inject({ method: 'GET', url: '/ops/runtime-health' });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      evidenceClass: string;
      overall: string;
      policy: { controlPlane: string; noMainGaDaemon: boolean };
      services: { total: number };
      schedules: { enabled: number };
    };
    assert.equal(body.evidenceClass, 'los_runtime');
    assert.ok(['ok', 'degraded', 'critical'].includes(body.overall));
    assert.equal(body.policy.controlPlane, 'gateway_embedded_timers');
    assert.equal(body.policy.noMainGaDaemon, true);
    assert.ok(typeof body.services.total === 'number');
    assert.ok(typeof body.schedules.enabled === 'number');
  } finally {
    await closeDb().catch(() => undefined);
    await app.close();
  }
});
