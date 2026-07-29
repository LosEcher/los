import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { Config } from '@los/infra/config';
import { getDb } from '@los/infra/db';

import { registerAuthRoutes } from './auth-routes.js';
import { registerRequestContext } from '../request-context.js';
import { setJwtSecret } from '../auth-store.js';

async function ensureUsersTable(): Promise<void> {
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('operator', 'user')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await getDb().exec(`TRUNCATE TABLE users RESTART IDENTITY CASCADE`);
}

function testConfig(): Config {
  return {
    auth: {
      enabled: true,
      token: 'access-token',
      operatorToken: 'operator-secret',
    },
    defaultProjectId: 'los',
  } as Config;
}

async function buildApp() {
  setJwtSecret('test-jwt-secret-for-auth-routes');
  await ensureUsersTable();
  const app = Fastify({ logger: false });
  const config = testConfig();
  registerRequestContext(app, config);
  await registerAuthRoutes(app, { config });
  return app;
}

test('bootstrap registration forces first user to operator even when client requests user', async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        username: 'bootstrap-user',
        password: 'secret12',
        role: 'user',
      },
    });
    assert.equal(response.statusCode, 201);
    const body = response.json() as { role: string; username: string };
    assert.equal(body.role, 'operator');
    assert.equal(body.username, 'bootstrap-user');
  } finally {
    await app.close();
  }
});

test('post-bootstrap registration requires operator and defaults non-operator role to user', async () => {
  const app = await buildApp();
  try {
    const first = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'first-op', password: 'secret12', role: 'user' },
    });
    assert.equal(first.statusCode, 201);
    assert.equal((first.json() as { role: string }).role, 'operator');

    const denied = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'second', password: 'secret12' },
    });
    assert.equal(denied.statusCode, 403);

    const allowed = await app.inject({
      method: 'POST',
      url: '/auth/register',
      headers: { 'x-los-operator-token': 'operator-secret' },
      payload: { username: 'second', password: 'secret12' },
    });
    assert.equal(allowed.statusCode, 201);
    assert.equal((allowed.json() as { role: string }).role, 'user');
  } finally {
    await app.close();
  }
});
