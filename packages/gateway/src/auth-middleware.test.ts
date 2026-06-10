import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { Config } from '@los/infra/config';

import authMiddleware from './auth-middleware.js';

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
  app.get('/settings', async () => ({ ok: true }));
  app.get('/health', async () => ({ status: 'ok' }));

  try {
    const missing = await app.inject({ method: 'GET', url: '/settings' });
    assert.equal(missing.statusCode, 401);

    const invalid = await app.inject({
      method: 'GET',
      url: '/settings',
      headers: { 'x-los-auth-token': 'wrong-token' },
    });
    assert.equal(invalid.statusCode, 401);

    const valid = await app.inject({
      method: 'GET',
      url: '/settings',
      headers: { 'x-los-auth-token': 'test-token' },
    });
    assert.equal(valid.statusCode, 200);

    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
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
    },
    providers: {},
    memory: {
      ftsEnabled: true,
      maxObservations: 10000,
    },
    executor: {
      enabled: false,
      meshNodes: [],
    },
    profile: 'test',
    defaultProjectId: 'los',
  };
}
