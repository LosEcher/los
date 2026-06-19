import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import { loadConfig } from '@los/infra/config';
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
