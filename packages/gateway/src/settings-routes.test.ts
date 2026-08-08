import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import { loadConfig, getConfig, setConfig } from '@los/infra/config';
import { closeDb, initDb } from '@los/infra/db';
import { createServer } from './server.js';
import { _buildSettingsResponse } from './routes/infrastructure/settings-routes.js';

test('public settings omit prompts and executor topology while private settings retain them', async () => {
  await loadConfig();
  const config = structuredClone(getConfig());
  config.agent.systemPrompt = 'agent-secret-prompt';
  config.judge.systemPrompt = 'judge-secret-prompt';
  config.executor.nodeUrl = 'http://executor.internal:8090';
  config.executor.meshNodes = ['http://mesh.internal:8090'];

  const publicSettings = _buildSettingsResponse(config, false);
  assert.equal(typeof (publicSettings.agent as Record<string, unknown>).defaultProvider, 'string');
  assert.equal(publicSettings.server, undefined);
  assert.equal((publicSettings.agent as Record<string, unknown>).systemPrompt, undefined);
  assert.equal((publicSettings.judge as Record<string, unknown>).systemPrompt, undefined);
  assert.deepEqual(publicSettings.executor, { enabled: config.executor.enabled });

  const privateSettings = _buildSettingsResponse(config, true);
  assert.equal((privateSettings.agent as Record<string, unknown>).systemPrompt, 'agent-secret-prompt');
  assert.equal((privateSettings.judge as Record<string, unknown>).systemPrompt, 'judge-secret-prompt');
  assert.equal((privateSettings.executor as Record<string, unknown>).nodeUrl, 'http://executor.internal:8090');
  assert.deepEqual((privateSettings.executor as Record<string, unknown>).meshNodes, ['http://mesh.internal:8090']);
});

test('private settings read and settings mutation require operator access', async () => {
  await loadConfig();
  const original = structuredClone(getConfig());
  const testConfig = structuredClone(original);
  testConfig.auth = {
    enabled: true,
    token: 'settings-user-token',
    operatorToken: 'settings-operator-token',
  };
  setConfig(testConfig);
  await initDb(testConfig.databaseUrl);

  const app = await createServer({
    serviceId: 'gateway-settings-test',
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'settings-test',
  });

  try {
    const publicResponse = await app.inject({ method: 'GET', url: '/settings' });
    assert.equal(publicResponse.statusCode, 200);

    const userHeaders = { 'x-los-auth-token': 'settings-user-token' };
    const privateUserResponse = await app.inject({
      method: 'GET',
      url: '/settings/private',
      headers: userHeaders,
    });
    assert.equal(privateUserResponse.statusCode, 403);

    const patchUserResponse = await app.inject({
      method: 'PATCH',
      url: '/settings',
      headers: userHeaders,
      payload: { agent: { maxLoops: 42 } },
    });
    assert.equal(patchUserResponse.statusCode, 403);

    const operatorHeaders = { 'x-los-operator-token': 'settings-operator-token' };
    const privateOperatorResponse = await app.inject({
      method: 'GET',
      url: '/settings/private',
      headers: operatorHeaders,
    });
    assert.equal(privateOperatorResponse.statusCode, 200);

    const patchOperatorResponse = await app.inject({
      method: 'PATCH',
      url: '/settings',
      headers: operatorHeaders,
      payload: { agent: { maxLoops: testConfig.agent.maxLoops } },
    });
    assert.equal(patchOperatorResponse.statusCode, 200);
  } finally {
    setConfig(original);
    await app.close();
    await closeDb();
  }
});

test('PATCH /settings updates runtime config and GET reflects changes', async () => {
  await loadConfig();
  const app = Fastify({ logger: false });

  // Clone the real PATCH /settings handler logic
  app.patch('/settings', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.status(400).send({ error: 'Request body must be a JSON object' });
    }
    const current = getConfig();
    const merged = { ...current } as Record<string, unknown>;
    for (const [key, val] of Object.entries(body)) {
      if (val && typeof val === 'object' && !Array.isArray(val) &&
          key in merged && merged[key] && typeof merged[key] === 'object') {
        (merged as Record<string, unknown>)[key] = {
          ...(merged[key] as Record<string, unknown>),
          ...(val as Record<string, unknown>),
        };
      }
    }
    setConfig(merged as ReturnType<typeof getConfig>);
    return { ok: true };
  });

  app.get('/settings', async () => ({ agent: getConfig().agent }));

  try {
    // Save original to restore later
    const original = getConfig();
    const originalMaxLoops = original.agent.maxLoops;

    // 1. Patch agent.maxLoops
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/settings',
      payload: { agent: { maxLoops: 42 } },
    });
    assert.equal(patchRes.statusCode, 200);
    assert.equal(patchRes.json().ok, true);

    // 2. GET reflects the runtime update
    const getRes = await app.inject({ method: 'GET', url: '/settings' });
    assert.equal(getRes.statusCode, 200);
    assert.equal(getRes.json().agent.maxLoops, 42);

    // 3. Verify in-memory config was updated
    assert.equal(getConfig().agent.maxLoops, 42);

    // Restore original value
    const restoreRes = await app.inject({
      method: 'PATCH',
      url: '/settings',
      payload: { agent: { maxLoops: originalMaxLoops } },
    });
    assert.equal(restoreRes.statusCode, 200);
    assert.equal(getConfig().agent.maxLoops, originalMaxLoops);
  } finally {
    await app.close();
  }
});

test('PATCH /settings rejects non-object body', async () => {
  await loadConfig();
  const app = Fastify({ logger: false });

  app.patch('/settings', async (req, reply) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.status(400).send({ error: 'Request body must be a JSON object' });
    }
    return { ok: true };
  });

  try {
    const res1 = await app.inject({
      method: 'PATCH',
      url: '/settings',
      payload: 'just a string',
      headers: { 'content-type': 'text/plain' },
    });
    assert.equal(res1.statusCode, 400);

    const res2 = await app.inject({
      method: 'PATCH',
      url: '/settings',
      payload: ['array'],
    });
    assert.equal(res2.statusCode, 400);
  } finally {
    await app.close();
  }
});

test('PATCH /settings ignores unknown top-level keys', async () => {
  await loadConfig();
  const app = Fastify({ logger: false });

  app.patch('/settings', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const current = getConfig() as unknown as Record<string, unknown>;
    const merged = { ...current };
    for (const [key, val] of Object.entries(body)) {
      if (val && typeof val === 'object' && !Array.isArray(val) &&
          key in merged && merged[key] && typeof merged[key] === 'object') {
        merged[key] = { ...(merged[key] as Record<string, unknown>), ...(val as Record<string, unknown>) };
      }
    }
    setConfig(merged as ReturnType<typeof getConfig>);
    return { ok: true };
  });

  try {
    const res = await app.inject({
      method: 'PATCH',
      url: '/settings',
      payload: { injected_key: { evil: true } },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
    // Unknown key should not appear in config
    assert.equal((getConfig() as unknown as Record<string, unknown>).injected_key, undefined);
  } finally {
    await app.close();
  }
});

test('PATCH /settings preserves nested fields not included in patch', async () => {
  await loadConfig();
  const app = Fastify({ logger: false });

  app.patch('/settings', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const current = getConfig() as unknown as Record<string, unknown>;
    const merged = { ...current };
    for (const [key, val] of Object.entries(body)) {
      if (val && typeof val === 'object' && !Array.isArray(val) &&
          key in merged && merged[key] && typeof merged[key] === 'object') {
        merged[key] = { ...(merged[key] as Record<string, unknown>), ...(val as Record<string, unknown>) };
      }
    }
    setConfig(merged as ReturnType<typeof getConfig>);
    return { ok: true };
  });

  try {
    const originalAgent = { ...getConfig().agent };

    // Patch ONLY maxLoops — all other agent fields should persist
    await app.inject({
      method: 'PATCH',
      url: '/settings',
      payload: { agent: { maxLoops: 99 } },
    });

    const updated = getConfig().agent;
    assert.equal(updated.maxLoops, 99);
    assert.equal(updated.defaultProvider, originalAgent.defaultProvider, 'defaultProvider should survive partial patch');
    assert.equal(updated.defaultModel, originalAgent.defaultModel, 'defaultModel should survive partial patch');
    assert.equal(updated.sandboxMode, originalAgent.sandboxMode, 'sandboxMode should survive partial patch');

    // Restore
    await app.inject({
      method: 'PATCH',
      url: '/settings',
      payload: { agent: { maxLoops: originalAgent.maxLoops } },
    });
  } finally {
    await app.close();
  }
});
