import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { Config } from '@los/infra/config';

import authMiddleware from './auth-middleware.js';
import { registerSecurityHeaders } from './security-headers.js';

test('auth middleware allows requests when auth is disabled', async () => {
  const app = Fastify({ logger: false });
  await authMiddleware(app, { config: configForAuth(false) });
  app.get('/settings', async () => ({ ok: true }));

  try {
    const response = await app.inject({ method: 'GET', url: '/settings' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true });
  } finally {
    await app.close();
  }
});

test('executor heartbeat requires the shared agent key when configured', async () => {
  const app = Fastify({ logger: false });
  const cfg = configForAuth(false);
  cfg.executor.agentKey = 'executor-heartbeat-key';
  await authMiddleware(app, { config: cfg });
  app.post('/nodes/heartbeat', async () => ({ ok: true }));

  try {
    const missing = await app.inject({ method: 'POST', url: '/nodes/heartbeat', payload: {} });
    assert.equal(missing.statusCode, 401);

    const invalid = await app.inject({
      method: 'POST',
      url: '/nodes/heartbeat',
      headers: { authorization: 'Bearer wrong-key' },
      payload: {},
    });
    assert.equal(invalid.statusCode, 401);

    const valid = await app.inject({
      method: 'POST',
      url: '/nodes/heartbeat',
      headers: { authorization: 'Bearer executor-heartbeat-key' },
      payload: {},
    });
    assert.equal(valid.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('auth middleware accepts access_token query for browser WebSocket/EventSource', async () => {
  const app = Fastify({ logger: false });
  await authMiddleware(app, { config: configForAuth(true) });
  app.get('/sessions/:id/stream/ws', async () => ({ ok: true }));
  app.get('/sessions/:id/events/live', async () => ({ ok: true }));

  try {
    const missing = await app.inject({ method: 'GET', url: '/sessions/s1/stream/ws' });
    assert.equal(missing.statusCode, 401);

    const viaQuery = await app.inject({
      method: 'GET',
      url: '/sessions/s1/stream/ws?access_token=test-token',
    });
    assert.equal(viaQuery.statusCode, 200);

    const live = await app.inject({
      method: 'GET',
      url: '/sessions/s1/events/live?access_token=test-token',
    });
    assert.equal(live.statusCode, 200);

    const wrong = await app.inject({
      method: 'GET',
      url: '/sessions/s1/stream/ws?access_token=wrong',
    });
    assert.equal(wrong.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('auth middleware keeps PWA shell assets public without credentials', async () => {
  const app = Fastify({ logger: false });
  await authMiddleware(app, { config: configForAuth(true) });
  for (const path of ['/', '/favicon.ico', '/manifest.webmanifest', '/icon.svg', '/sw.js', '/assets/app.js']) {
    app.get(path, async () => ({ path }));
  }
  app.get('/chat', async () => ({ ok: true }));

  try {
    for (const path of ['/', '/favicon.ico', '/manifest.webmanifest', '/icon.svg', '/sw.js', '/assets/app.js']) {
      const response = await app.inject({ method: 'GET', url: path });
      assert.equal(response.statusCode, 200, `${path} should be public`);
    }
    // Query string must not break exact public matches.
    const manifestWithQuery = await app.inject({ method: 'GET', url: '/manifest.webmanifest?v=1' });
    assert.equal(manifestWithQuery.statusCode, 200);

    // API surfaces stay protected.
    const chat = await app.inject({ method: 'GET', url: '/chat' });
    assert.equal(chat.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('auth middleware requires the configured token outside public paths', async () => {
  const app = Fastify({ logger: false });
  await authMiddleware(app, { config: configForAuth(true) });
  app.get('/protected', async () => ({ ok: true }));
  app.get('/health', async () => ({ status: 'ok' }));

  try {
    const missing = await app.inject({ method: 'GET', url: '/protected' });
    assert.equal(missing.statusCode, 401);

    const invalid = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { 'x-los-auth-token': 'wrong-token' },
    });
    assert.equal(invalid.statusCode, 401);

    const valid = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { 'x-los-auth-token': 'test-token' },
    });
    assert.equal(valid.statusCode, 200);

    // WeClaw / OpenAI-compatible clients send Authorization: Bearer
    const bearer = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal(bearer.statusCode, 200);

    const badBearer = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer wrong-token' },
    });
    assert.equal(badBearer.statusCode, 401);

    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('auth middleware protects settings mutation and operator runtime control paths', async () => {
  const app = Fastify({ logger: false });
  await authMiddleware(app, { config: configForAuth(true) });
  app.get('/settings', async () => ({ ok: true }));
  app.patch('/settings', async () => ({ ok: true }));
  app.post('/operator/tool-gate', async () => ({ ok: true }));
  app.get('/operator/events/live', async () => ({ ok: true }));
  app.post('/runtimes/codex/run', async () => ({ ok: true }));
  app.post('/v1/chat/completions', async () => ({ ok: true }));
  app.post('/chat', async () => ({ ok: true }));
  app.post('/sessions/session-a/operator-events', async () => ({ ok: true }));
  app.get('/sessions/session-a/events/live', async () => ({ ok: true }));

  try {
    const publicSettings = await app.inject({ method: 'GET', url: '/settings?tab=auth' });
    assert.equal(publicSettings.statusCode, 200);

    for (const request of [
      { method: 'PATCH', url: '/settings' },
      { method: 'POST', url: '/operator/tool-gate' },
      { method: 'GET', url: '/operator/events/live' },
      { method: 'POST', url: '/runtimes/codex/run' },
      { method: 'POST', url: '/v1/chat/completions' },
      { method: 'POST', url: '/chat' },
      { method: 'POST', url: '/sessions/session-a/operator-events' },
      { method: 'GET', url: '/sessions/session-a/events/live' },
    ] as const) {
      const missing = await app.inject(request);
      assert.equal(missing.statusCode, 401, `${request.method} ${request.url} should require auth`);

      const valid = await app.inject({
        ...request,
        headers: { 'x-los-auth-token': 'test-token' },
      });
      assert.equal(valid.statusCode, 200, `${request.method} ${request.url} should accept auth`);
    }
  } finally {
    await app.close();
  }
});

test('auth middleware accepts operator token without auth token when operatorToken is set', async () => {
  const app = Fastify({ logger: false });
  const cfg = configForAuth(true);
  cfg.auth.operatorToken = 'operator-secret';
  await authMiddleware(app, { config: cfg });
  app.post('/sessions/session-a/operator-events', async () => ({ ok: true }));
  app.get('/protected', async () => ({ ok: true }));

  try {
    // operator token should pass through
    const opOk = await app.inject({
      method: 'POST',
      url: '/sessions/session-a/operator-events',
      headers: { 'x-los-operator-token': 'operator-secret' },
    });
    assert.equal(opOk.statusCode, 200);

    // wrong operator token should still 401
    const opBad = await app.inject({
      method: 'POST',
      url: '/sessions/session-a/operator-events',
      headers: { 'x-los-operator-token': 'wrong-operator' },
    });
    assert.equal(opBad.statusCode, 401);

    // operator token also works for general protected paths
    const genOk = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { 'x-los-operator-token': 'operator-secret' },
    });
    assert.equal(genOk.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('security headers do not emit CSP unless explicitly configured', async () => {
  const app = Fastify({ logger: false });
  registerSecurityHeaders(app);
  app.get('/', async () => '<html><script>window.ok=true</script></html>');

  try {
    const response = await app.inject({ method: 'GET', url: '/' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['content-security-policy'], undefined);
  } finally {
    await app.close();
  }
});

test('security headers emit CSP when explicitly configured', async () => {
  const app = Fastify({ logger: false });
  registerSecurityHeaders(app, { contentSecurityPolicy: "default-src 'self'" });
  app.get('/', async () => ({ ok: true }));

  try {
    const response = await app.inject({ method: 'GET', url: '/' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-security-policy'], "default-src 'self'");
  } finally {
    await app.close();
  }
});

function configForAuth(enabled: boolean): Config {
  return {
    databaseUrl: 'postgres://los:los@127.0.0.1:5432/los',
    server: {
      port: 8080,
      host: '127.0.0.1',
      corsOrigin: 'http://localhost:5173',
      localEndpoints: [],
    },
    auth: {
      enabled,
      token: 'test-token',
    },
    integrations: { feedAnalysis: {
      resultReturningEnabled: true, maxInlineBytes: 1048576, maxItems: 500,
      materialHosts: [], materialFetchTimeoutMs: 10000, executionTimeoutMs: 120000, callbackPollMs: 5000, callbackProfiles: {},
    } },
    agent: {
      defaultProvider: 'deepseek',
      defaultModel: 'deepseek-v4-flash',
      maxLoops: 20,
      sandboxMode: 'workspace-write',
      allowNativeShell: false,
      identity: { name: 'default', inheritForChildren: false },
      skills: { runtimeEnabled: true, autoInject: false, maxAutoSkills: 3, maxSkillTokens: 2500 },
      rules: { operatorInject: true, enforcementEnabled: true, maxPromptRules: 20 },
    },
    judge: {},
    review: { enabled: false, roles: {} },
    providers: {},
    memory: {
      ftsEnabled: true,
      maxObservations: 10000,
      persistChatDefault: true,
      selfReflectionEnabled: false,
      codeGraph: {
        enabled: false,
        shadowMode: false,
        injectArchitecture: false,
        cbmCommand: 'codebase-memory-mcp',
        cbmArgs: [],
        maxPromptTokens: 400,
      },
    },
    executor: {
      enabled: false,
      host: '127.0.0.1',
      port: 8090,
      shutdownGraceMs: 120_000,
      nodeKind: 'executor',
      connectModes: [],
      meshNodes: [],
    },
    profile: 'test',
    defaultProjectId: 'los',
    migrationsDir: 'packages/infra/migrations',
  };
}
