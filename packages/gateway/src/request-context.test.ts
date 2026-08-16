import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { loadConfig, setConfig, type Config } from '@los/infra/config';

import {
  _requiresActorContext,
  getRequestContext,
  registerRequestContext,
  resolveTenantScope,
  resolveProjectScope,
} from './request-context.js';

test('infrastructure health and heartbeat paths do not require actor context', () => {
  for (const path of ['/health', '/live', '/ready', '/nodes/heartbeat', '/health?probe=1']) {
    assert.equal(_requiresActorContext(path), false, path);
  }
});

test('user and operator routes continue to require actor context', () => {
  for (const path of ['/chat', '/nodes', '/services', '/runs/run-1']) {
    assert.equal(_requiresActorContext(path), true, path);
  }
});

function configWithAuth(enabled: boolean): Config {
  return {
    auth: {
      enabled,
      token: 'access-token',
      operatorToken: 'operator-token',
    },
    defaultProjectId: 'los',
  } as Config;
}

test('operator token without x-user-id resolves to operator:shared-token (not unknown)', async () => {
  const app = Fastify({ logger: false });
  registerRequestContext(app, configWithAuth(true));
  app.get('/whoami', async (req) => {
    const ctx = getRequestContext(req);
    return { userId: ctx.userId, isOperator: ctx.isOperator };
  });
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { 'x-los-operator-token': 'operator-token' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().isOperator, true);
    assert.equal(response.json().userId, 'operator:shared-token');
  } finally {
    await app.close();
  }
});

test('operator token prefers explicit x-user-id for canary actor labeling', async () => {
  const app = Fastify({ logger: false });
  registerRequestContext(app, configWithAuth(true));
  app.get('/whoami', async (req) => ({ userId: getRequestContext(req).userId }));
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: {
        'x-los-operator-token': 'operator-token',
        'x-user-id': 'operator:alice',
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().userId, 'operator:alice');
  } finally {
    await app.close();
  }
});

// ── tenant/project scope resolution (P1-08) ──────────────────

function scopeConfig(authEnabled: boolean): Config {
  const base = configWithAuth(authEnabled);
  return { ...base, auth: { enabled: authEnabled, token: 'access-token', operatorToken: 'operator-token' }, defaultProjectId: 'los' } as Config;
}

test('non-operator tenant/project scope is pinned to requestContext (ignores override)', async () => {
  const previousConfig = await loadConfig();
  setConfig(scopeConfig(true));
  const app = Fastify({ logger: false });
  registerRequestContext(app, scopeConfig(true));
  app.get('/scope', async (req) => ({
    tenant: resolveTenantScope(req, 'evil-tenant'),
    project: resolveProjectScope(req, 'evil-project'),
  }));
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/scope',
      headers: { 'x-los-auth-token': 'access-token' },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { tenant: 'local', project: 'los' });
  } finally {
    setConfig(previousConfig);
    await app.close();
  }
});

test('operator may override tenant/project scope', async () => {
  const previousConfig = await loadConfig();
  setConfig(scopeConfig(true));
  const app = Fastify({ logger: false });
  registerRequestContext(app, scopeConfig(true));
  app.get('/scope', async (req) => ({
    tenant: resolveTenantScope(req, 'tenant-a'),
    project: resolveProjectScope(req, 'project-a'),
  }));
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/scope',
      headers: { 'x-los-operator-token': 'operator-token' },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { tenant: 'tenant-a', project: 'project-a' });
  } finally {
    setConfig(previousConfig);
    await app.close();
  }
});

test('auth-disabled requests keep caller-supplied tenant/project override', async () => {
  const previousConfig = await loadConfig();
  setConfig(scopeConfig(false));
  const app = Fastify({ logger: false });
  registerRequestContext(app, scopeConfig(false));
  app.get('/scope', async (req) => ({
    tenant: resolveTenantScope(req, 'tenant-a'),
    project: resolveProjectScope(req, 'project-a'),
  }));
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/scope',
      headers: { 'x-tenant-id': 'tenant-a', 'x-project-id': 'project-a' },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { tenant: 'tenant-a', project: 'project-a' });
  } finally {
    setConfig(previousConfig);
    await app.close();
  }
});
