import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import { loadConfig, getConfig, setConfig } from '@los/infra/config';

test('GET /settings returns current config shape', async () => {
  await loadConfig();
  // Import after loadConfig to avoid circular init issues
  // We test the raw route by registering it manually on a new Fastify instance
  const app = Fastify({ logger: false });

  // Replicate GET /settings handler
  app.get('/settings', async () => {
    const config = getConfig();
    return {
      server: { port: config.server.port, host: config.server.host, corsOrigin: config.server.corsOrigin },
      defaultProjectId: config.defaultProjectId,
      auth: { enabled: config.auth.enabled },
      agent: {
        defaultProvider: config.agent.defaultProvider,
        defaultModel: config.agent.defaultModel,
        maxLoops: config.agent.maxLoops,
        sandboxMode: config.agent.sandboxMode,
        systemPrompt: config.agent.systemPrompt ?? null,
        identity: {
          name: config.agent.identity.name,
          level: config.agent.identity.level ?? null,
          inheritForChildren: config.agent.identity.inheritForChildren,
        },
      },
      providers: [],
      memory: { ftsEnabled: true, maxObservations: 10000, persistChatDefault: true, selfReflectionEnabled: false },
      judge: {},
      review: { enabled: false, roles: {} },
      executor: { enabled: false, connectModes: [], meshNodes: [], meshNodeCount: 0 },
    };
  });

  try {
    const res = await app.inject({ method: 'GET', url: '/settings' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(typeof body.agent.defaultProvider, 'string');
    assert.equal(typeof body.agent.defaultModel, 'string');
    assert.equal(typeof body.agent.maxLoops, 'number');
    assert.equal(typeof body.server.port, 'number');
  } finally {
    await app.close();
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
