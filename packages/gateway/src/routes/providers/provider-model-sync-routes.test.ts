/**
 * Provider model sync route tests.
 *
 * Fastify inject-based tests for POST /providers/:name/models/sync with
 * dependency-injected fetch and OAuth resolvers — no real network calls.
 * Each test registers its own provider entry so runs are isolated from
 * whatever the shared test process left in the global config.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { getConfig, loadConfig, setConfig, type Config } from '@los/infra/config';
import {
  registerProviderModelSyncRoutes,
  type ProviderModelSyncDependencies,
} from './provider-model-sync-routes.js';

const XAI_MODELS_BODY = {
  object: 'list',
  data: [
    { id: 'grok-4.5', object: 'model', owned_by: 'xai' },
    { id: 'grok-4.3', object: 'model', owned_by: 'xai' },
    { id: 'grok-4.20-0309-reasoning', object: 'model', owned_by: 'xai' },
  ],
};

function createDeps(overrides: Partial<ProviderModelSyncDependencies> = {}): ProviderModelSyncDependencies {
  return {
    fetchJson: async () => ({ status: 200, body: XAI_MODELS_BODY }),
    resolveOAuthCredential: async () => ({ apiKey: 'oauth-key', baseUrl: 'https://api.x.ai/v1' }),
    ...overrides,
  };
}

let app: FastifyInstance;
let originalConfig: Config;
const TEST_PROVIDER = `sync-test-${Date.now()}`;

function installTestProvider(): void {
  const config = getConfig();
  config.providers[TEST_PROVIDER] = {
    enabled: true,
    weight: 100,
    apiKey: 'sk-test',
    model: 'grok-4.3',
    baseUrl: 'https://api.x.ai/v1',
    source: 'test',
  };
  setConfig(config);
}

test.before(async () => {
  originalConfig = structuredClone(await loadConfig());
  installTestProvider();
  app = Fastify({ logger: false });
  registerProviderModelSyncRoutes(app, createDeps());
  await app.ready();
});

test.beforeEach(() => {
  installTestProvider();
});

test.after(async () => {
  await app.close();
  setConfig(originalConfig);
});

test('POST /providers/:name/models/sync lists the remote model catalog', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/providers/${TEST_PROVIDER}/models/sync`,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.provider, TEST_PROVIDER);
  assert.equal(body.count, 3);
  assert.deepEqual(body.models.map((m: { id: string }) => m.id), [
    'grok-4.5',
    'grok-4.3',
    'grok-4.20-0309-reasoning',
  ]);
  assert.equal(body.applied, false);
  assert.equal(body.appliedModel, null);
});

test('POST /providers/:name/models/sync applies a model when applyModel is in the catalog', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/providers/${TEST_PROVIDER}/models/sync`,
    payload: { applyModel: 'grok-4.5' },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.applied, true);
  assert.equal(body.appliedModel, 'grok-4.5');
  assert.equal(getConfig().providers[TEST_PROVIDER]?.model, 'grok-4.5');
});

test('POST /providers/:name/models/sync rejects a model not in the catalog', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/providers/${TEST_PROVIDER}/models/sync`,
    payload: { applyModel: 'grok-9.9' },
  });
  assert.equal(res.statusCode, 422);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'model_not_in_catalog');
  assert.ok(Array.isArray(body.available));
});

test('POST /providers/:name/models/sync returns 404 for unknown providers', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/providers/does-not-exist/models/sync',
  });
  assert.equal(res.statusCode, 404);
});

test('POST /providers/:name/models/sync returns 404 for disabled providers', async () => {
  const config = getConfig();
  config.providers[TEST_PROVIDER] = { ...config.providers[TEST_PROVIDER], enabled: false };
  setConfig(config);
  const res = await app.inject({
    method: 'POST',
    url: `/providers/${TEST_PROVIDER}/models/sync`,
  });
  assert.equal(res.statusCode, 404);
});

test('POST /providers/:name/models/sync propagates remote failures as 400', async () => {
  const failingApp = Fastify({ logger: false });
  registerProviderModelSyncRoutes(failingApp, createDeps({
    fetchJson: async () => ({ status: 401, body: { error: { message: 'Invalid Authentication' } } }),
  }));
  await failingApp.ready();
  try {
    const res = await failingApp.inject({
      method: 'POST',
      url: `/providers/${TEST_PROVIDER}/models/sync`,
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'remote_models_fetch_failed');
  } finally {
    await failingApp.close();
  }
});

test('POST /providers/:name/models/sync uses the OAuth resolver for credential-less providers', async () => {
  const oauthApp = Fastify({ logger: false });
  registerProviderModelSyncRoutes(oauthApp, createDeps({
    resolveOAuthCredential: async (provider) => {
      assert.equal(provider, TEST_PROVIDER);
      return { apiKey: 'oauth-key', baseUrl: 'https://api.kimi.com/coding/v1' };
    },
    fetchJson: async (url) => {
      assert.match(url, /\/coding\/v1\/models$/);
      return { status: 200, body: { data: [{ id: 'kimi-k3' }] } };
    },
  }));
  await oauthApp.ready();
  try {
    // Credential-less provider: no apiKey, authMode oauth — resolver must kick in.
    const config = getConfig();
    delete config.providers[TEST_PROVIDER].apiKey;
    config.providers[TEST_PROVIDER] = {
      ...config.providers[TEST_PROVIDER],
      authMode: 'oauth',
    };
    setConfig(config);
    const res = await oauthApp.inject({
      method: 'POST',
      url: `/providers/${TEST_PROVIDER}/models/sync`,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.count, 1);
    assert.equal(body.baseUrl, 'https://api.kimi.com/coding/v1');
  } finally {
    await oauthApp.close();
  }
});
