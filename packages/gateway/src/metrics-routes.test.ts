import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { registerRequestContext } from './request-context.js';
import { registerMetricsRoutes } from './routes/infrastructure/metrics-routes.js';

test('GET /metrics renders task run and provider samples from persisted evidence', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const app = Fastify({ logger: false });
  registerRequestContext(app, config);
  registerMetricsRoutes(app);
  try {
    const { ensureTaskRunStore } = await import('@los/agent/task-runs');
    const { ensureProviderCallTelemetryStore } = await import('@los/agent/providers/telemetry');
    await Promise.all([ensureTaskRunStore(), ensureProviderCallTelemetryStore()]);

    const stamp = `${Date.now()}`;
    await getDb().query(
      `INSERT INTO task_runs (id, session_id, workspace_root, tool_mode, status, started_at, completed_at)
       VALUES ($1, $2, $3, 'read-only', 'succeeded', now() - interval '10 seconds', now())`,
      [`metrics-task-${stamp}`, `metrics-session-${stamp}`, '/tmp'],
    );
    await getDb().query(
      `INSERT INTO provider_call_telemetry (trace_id, session_id, provider, model, endpoint, status, duration_ms)
       VALUES ($1, $2, 'deepseek', 'fixture-model', '/v1/chat', 200, 120)`,
      [`metrics-trace-${stamp}`, `metrics-session-${stamp}`],
    );

    const response = await app.inject({ method: 'GET', url: '/metrics' });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] ?? '', /text\/plain|application\/json|text\/json/);
    const body = response.body;
    assert.match(body, /^# HELP los_task_runs_total Total task runs by final status\.$/m);
    assert.match(body, /^los_task_runs_total\{status="succeeded"\} 1$/m);
    assert.match(body, /^los_task_run_duration_milliseconds\{status="succeeded",quantile="avg"\} /m);
    assert.match(body, /^los_provider_calls_total\{provider="deepseek"\} 1$/m);
    assert.match(body, /^los_provider_errors_total\{provider="deepseek"\} 0$/m);
    assert.match(body, /^los_provider_duration_milliseconds\{provider="deepseek"\} 120$/m);
  } finally {
    await getDb().query(`DELETE FROM task_runs WHERE id LIKE 'metrics-task-%'`).catch(() => undefined);
    await getDb().query(`DELETE FROM provider_call_telemetry WHERE trace_id LIKE 'metrics-trace-%'`).catch(() => undefined);
    await closeDb().catch(() => undefined);
    await app.close();
  }
});
