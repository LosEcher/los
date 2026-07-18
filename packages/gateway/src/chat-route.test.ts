import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { ensureSessionEventStore, listSessionEvents } from '@los/agent/session-events';
import { loadConfig, type Config } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';

import { resolveDirectRunCompletionDecision } from './chat-run-completion.js';
import { registerChatRoute } from './chat-route.js';
import { ensureIdempotencyStore } from './idempotency.js';

function withConfiguredDefaultProvider(config: Config): Config {
  const provider = config.agent.defaultProvider;
  return {
    ...config,
    providers: {
      ...config.providers,
      [provider]: {
        ...config.providers[provider],
        enabled: true,
        model: config.agent.defaultModel,
      },
    },
  };
}

test('direct chat run completion blocks on unsatisfied required verification records', () => {
  const decision = resolveDirectRunCompletionDecision([
    { id: 'check-required', checkName: 'required', required: true, status: 'required' },
    { id: 'check-running', checkName: 'running', required: true, status: 'running' },
    { id: 'check-failed', checkName: 'failed', required: true, status: 'failed' },
    { id: 'check-optional-failed', checkName: 'optional', required: false, status: 'failed' },
  ]);

  assert.equal(decision.status, 'blocked');
  assert.deepEqual(decision.blockedVerificationRecordIds, [
    'check-required',
    'check-running',
    'check-failed',
  ]);
});

test('direct chat run completion succeeds only for allowlisted skipped verification', () => {
  const decision = resolveDirectRunCompletionDecision([
    { id: 'check-ok', checkName: 'pnpm check', required: true, status: 'succeeded' },
    { id: 'check-skipped', checkName: 'browser smoke', required: true, status: 'skipped' },
    { id: 'check-optional-failed', checkName: 'optional', required: false, status: 'failed' },
  ], ['browser smoke']);

  assert.equal(decision.status, 'succeeded');
  assert.deepEqual(decision.blockedVerificationRecordIds, []);
});

test('direct chat run completion blocks non-allowlisted skipped verification', () => {
  const decision = resolveDirectRunCompletionDecision([
    { id: 'check-skipped', checkName: 'browser smoke', required: true, status: 'skipped' },
  ]);
  assert.equal(decision.status, 'blocked');
});

test('chat route keeps a 1MB request body limit', async () => {
  const app = Fastify({ logger: false });
  registerChatRoute(app, {} as any, process.cwd());

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/chat',
      payload: { prompt: 'x'.repeat(1024 * 1024 + 128) },
    });

    assert.equal(response.statusCode, 413);
  } finally {
    await app.close();
  }
});

test('chat route rejects requests that violate the generated run-spec validator', async () => {
  const app = Fastify({ logger: false });
  registerChatRoute(app, {} as any, process.cwd());

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/chat',
      payload: { prompt: 'invalid contract', toolMode: 'root', timeoutMs: 0 },
    });

    assert.equal(response.statusCode, 400);
    const body = response.json();
    assert.equal(body.error, 'invalid_run_spec_request');
    assert.deepEqual(body.issues.map((issue: { path: string }) => issue.path).sort(), [
      '/timeoutMs',
      '/toolMode',
    ]);
  } finally {
    await app.close();
  }
});

test('chat route rejects an unknown provider/model before creating a run', async () => {
  const config = await loadConfig();
  const app = Fastify({ logger: false });
  registerChatRoute(app, config, process.cwd());

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/chat',
      payload: { prompt: 'invalid provider', provider: 'deepseek-v4-flash' },
    });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), {
      error: 'invalid_provider_model',
      code: 'provider_not_configured',
      message: "provider 'deepseek-v4-flash' is not configured or disabled",
    });
  } finally {
    await app.close();
  }
});

test('chat route persists blocked intake before idempotency reservation', async () => {
  const config = withConfiguredDefaultProvider(await loadConfig());
  await initDb(config.databaseUrl);
  await ensureSessionEventStore();
  await ensureIdempotencyStore();
  const app = Fastify({ logger: false });
  registerChatRoute(app, config, process.cwd());
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-chat-intake-${suffix}`;
  const idempotencyKey = `chat-intake-${suffix}`;

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/chat',
      headers: { 'x-idempotency-key': idempotencyKey },
      payload: {
        prompt: 'blocked intake',
        sessionId,
        projectId: `missing-${suffix}`,
        provider: config.agent.defaultProvider,
        model: config.agent.defaultModel,
      },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().reason, 'unknown_explicit_project');
    const events = await listSessionEvents(sessionId);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'coordinator.intake_blocked');
    const reservations = await getDb().query<{ count: string }>(
      'SELECT count(*)::text AS count FROM idempotency_keys WHERE idempotency_key = $1',
      [idempotencyKey],
    );
    assert.equal(reservations.rows[0]?.count, '0');
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM idempotency_keys WHERE idempotency_key = $1', [idempotencyKey]).catch(() => undefined);
    await app.close();
    await closeDb().catch(() => undefined);
  }
});

test('chat route blocks conflicting body and context project IDs', async () => {
  const config = withConfiguredDefaultProvider(await loadConfig());
  await initDb(config.databaseUrl);
  await ensureSessionEventStore();
  const app = Fastify({ logger: false });
  registerChatRoute(app, config, process.cwd());
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-chat-context-conflict-${suffix}`;

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/chat',
      headers: { 'x-project-id': 'context-project' },
      payload: {
        prompt: 'blocked intake',
        sessionId,
        projectId: 'body-project',
        provider: config.agent.defaultProvider,
        model: config.agent.defaultModel,
      },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().reason, 'project_context_conflict');
    const events = await listSessionEvents(sessionId);
    assert.equal(events[0]?.payload.reason, 'project_context_conflict');
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await app.close();
    await closeDb().catch(() => undefined);
  }
});
