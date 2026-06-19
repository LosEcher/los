import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import { loadConfig, getConfig, setConfig } from '@los/infra/config';
import { registerProviderRoutes } from './routes/providers/provider-routes.js';

test('/providers/models exposes grouped providers and flat model records', async () => {
  await loadConfig();
  const app = Fastify({ logger: false });
  registerProviderRoutes(app);

  try {
    const response = await app.inject({ method: 'GET', url: '/providers/models' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.ok(Array.isArray(body.models));
    assert.ok(Array.isArray(body.providers));
    assert.equal(body.count, body.models.length);
    if (body.models.length > 0) {
      assert.equal(typeof body.models[0].provider, 'string');
      assert.equal(typeof body.models[0].model, 'string');
    }
    if (body.providers.length > 0) {
      assert.equal(typeof body.providers[0].provider, 'string');
      assert.ok(Array.isArray(body.providers[0].models));
    }
  } finally {
    await app.close();
  }
});

// ── Provider CRUD lifecycle tests ───────────────────────

test('POST /providers creates a new provider', async () => {
  await loadConfig();
  const app = Fastify({ logger: false });
  registerProviderRoutes(app);

  try {
    // Remove test provider if it somehow exists from a prior run
    const cfg = getConfig();
    delete cfg.providers['test-crud-provider'];
    setConfig(cfg);

    const res = await app.inject({
      method: 'POST',
      url: '/providers',
      payload: {
        name: 'test-crud-provider',
        apiKey: 'sk-test-key',
        baseUrl: 'https://api.test.example/v1',
        model: 'test-model-v1',
        enabled: true,
        weight: 50,
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.provider.name, 'test-crud-provider');
    assert.equal(body.provider.apiKey, 'sk-test-key');
    assert.equal(body.provider.baseUrl, 'https://api.test.example/v1');
    assert.equal(body.provider.model, 'test-model-v1');
    assert.equal(body.provider.enabled, true);
    assert.equal(body.provider.weight, 50);
    assert.equal(body.provider.source, 'manual');

    // Verify it's in config
    const updated = getConfig();
    assert.ok(updated.providers['test-crud-provider']);
    assert.equal(updated.providers['test-crud-provider'].apiKey, 'sk-test-key');
  } finally {
    const cfg = getConfig();
    delete cfg.providers['test-crud-provider'];
    setConfig(cfg);
    await app.close();
  }
});

test('POST /providers rejects empty name', async () => {
  await loadConfig();
  const app = Fastify({ logger: false });
  registerProviderRoutes(app);

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/providers',
      payload: { name: '   ', apiKey: 'sk-test' },
    });
    assert.equal(res.statusCode, 422);
  } finally {
    await app.close();
  }
});

test('POST /providers rejects duplicate name', async () => {
  await loadConfig();
  const app = Fastify({ logger: false });
  registerProviderRoutes(app);

  try {
    // Create it once
    await app.inject({
      method: 'POST',
      url: '/providers',
      payload: { name: 'test-dup-provider', apiKey: 'sk-1' },
    });
    // Attempt duplicate
    const res = await app.inject({
      method: 'POST',
      url: '/providers',
      payload: { name: 'test-dup-provider', apiKey: 'sk-2' },
    });
    assert.equal(res.statusCode, 409);
  } finally {
    const cfg = getConfig();
    delete cfg.providers['test-dup-provider'];
    setConfig(cfg);
    await app.close();
  }
});

test('POST /providers allows minimal payload (name only)', async () => {
  await loadConfig();
  const app = Fastify({ logger: false });
  registerProviderRoutes(app);

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/providers',
      payload: { name: 'test-minimal-provider' },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.provider.name, 'test-minimal-provider');
    assert.equal(body.provider.enabled, true);
    // Sanitize: spaces should be replaced
    const res2 = await app.inject({
      method: 'POST',
      url: '/providers',
      payload: { name: 'Test Spaces Provided!' },
    });
    assert.equal(res2.statusCode, 201);
    assert.equal(res2.json().provider.name, 'test-spaces-provided');
    delete getConfig().providers['test-minimal-provider'];
    delete getConfig().providers['test-spaces-provided'];
  } finally {
    const cfg = getConfig();
    delete cfg.providers['test-minimal-provider'];
    delete cfg.providers['test-spaces-provided'];
    setConfig(cfg);
    await app.close();
  }
});

test('PATCH /providers/:name updates existing provider fields', async () => {
  await loadConfig();
  const app = Fastify({ logger: false });
  registerProviderRoutes(app);

  try {
    // Create a provider first
    await app.inject({
      method: 'POST',
      url: '/providers',
      payload: { name: 'test-patch-provider', apiKey: 'sk-old', baseUrl: 'https://old.example', enabled: true },
    });

    // Patch it
    const res = await app.inject({
      method: 'PATCH',
      url: '/providers/test-patch-provider',
      payload: { apiKey: 'sk-new', baseUrl: 'https://new.example', enabled: false },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.provider.apiKey, 'sk-new');
    assert.equal(body.provider.baseUrl, 'https://new.example');
    assert.equal(body.provider.enabled, false);
  } finally {
    const cfg = getConfig();
    delete cfg.providers['test-patch-provider'];
    setConfig(cfg);
    await app.close();
  }
});

test('PATCH /providers/:name returns 404 for unknown provider', async () => {
  await loadConfig();
  const app = Fastify({ logger: false });
  registerProviderRoutes(app);

  try {
    const res = await app.inject({
      method: 'PATCH',
      url: '/providers/nonexistent-xyz',
      payload: { enabled: false },
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});

test('DELETE /providers/:name removes an existing provider', async () => {
  await loadConfig();
  const app = Fastify({ logger: false });
  registerProviderRoutes(app);

  try {
    // Create a provider first
    await app.inject({
      method: 'POST',
      url: '/providers',
      payload: { name: 'test-delete-provider', apiKey: 'sk-del' },
    });
    assert.ok(getConfig().providers['test-delete-provider']);

    // Delete it
    const res = await app.inject({
      method: 'DELETE',
      url: '/providers/test-delete-provider',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.removed, 'test-delete-provider');
    assert.equal(getConfig().providers['test-delete-provider'], undefined);
  } finally {
    const cfg = getConfig();
    delete cfg.providers['test-delete-provider'];
    setConfig(cfg);
    await app.close();
  }
});

test('DELETE /providers/:name returns 404 for unknown provider', async () => {
  await loadConfig();
  const app = Fastify({ logger: false });
  registerProviderRoutes(app);

  try {
    const res = await app.inject({
      method: 'DELETE',
      url: '/providers/nonexistent-xyz',
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});

test('provider CRUD full lifecycle: create → read → update → delete', async () => {
  await loadConfig();
  const app = Fastify({ logger: false });
  registerProviderRoutes(app);

  const providerName = 'test-lifecycle-provider';

  try {
    // Cleanup from any prior interrupted run
    const cfg = getConfig();
    delete cfg.providers[providerName];
    setConfig(cfg);

    // 1. Create
    const createRes = await app.inject({
      method: 'POST',
      url: '/providers',
      payload: { name: providerName, apiKey: 'sk-lifecycle', model: 'lifecycle-v1', weight: 80 },
    });
    assert.equal(createRes.statusCode, 201);
    assert.ok(createRes.json().ok);

    // 2. Read — verify via /providers/models includes it
    const readRes = await app.inject({ method: 'GET', url: '/providers/models' });
    assert.equal(readRes.statusCode, 200);
    const models = readRes.json();
    const foundModel = models.models.find((m: any) => m.provider === providerName);
    assert.ok(foundModel);
    assert.equal(foundModel.model, 'lifecycle-v1');

    // 3. Update
    const updateRes = await app.inject({
      method: 'PATCH',
      url: `/providers/${providerName}`,
      payload: { model: 'lifecycle-v2', weight: 90, enabled: false },
    });
    assert.equal(updateRes.statusCode, 200);
    assert.equal(updateRes.json().provider.model, 'lifecycle-v2');
    assert.equal(updateRes.json().provider.weight, 90);

    // 4. Read — verify update
    const cfg2 = getConfig();
    assert.equal(cfg2.providers[providerName].model, 'lifecycle-v2');
    assert.equal(cfg2.providers[providerName].weight, 90);
    assert.equal(cfg2.providers[providerName].enabled, false);

    // 5. Delete
    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/providers/${providerName}`,
    });
    assert.equal(deleteRes.statusCode, 200);
    assert.ok(deleteRes.json().ok);

    // 6. Verify deleted — not in config anymore
    const cfg3 = getConfig();
    assert.equal(cfg3.providers[providerName], undefined);
  } finally {
    const cfg = getConfig();
    delete cfg.providers[providerName];
    setConfig(cfg);
    await app.close();
  }
});
