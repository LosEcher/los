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
    agent: {
      defaultProvider: 'deepseek',
      defaultModel: 'deepseek-v4-flash',
      maxLoops: 20,
      sandboxMode: 'workspace-write',
      identity: { name: 'default', inheritForChildren: false },
    },
    judge: {},
    review: { enabled: false, roles: {} },
    providers: {},
    memory: {
      ftsEnabled: true,
      maxObservations: 10000,
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
      nodeKind: 'executor',
      connectModes: [],
      meshNodes: [],
    },
    profile: 'test',
    defaultProjectId: 'los',
    migrationsDir: 'packages/infra/migrations',
  };
}
