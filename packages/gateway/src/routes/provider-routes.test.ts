/**
 * provider-routes.test.ts — Integration tests for provider PATCH and DELETE endpoints.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, setConfig } from '@los/infra/config';
import { createServer } from '../server.js';

test('PATCH /providers/:name updates provider config', async () => {
  const config = await loadConfig();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const app = await createServer({
    serviceId: `gateway-prov-test-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });

  try {
    // Seed a test provider into config
    const testProvider = `test-prov-${suffix}`;
    config.providers[testProvider] = { enabled: true, model: 'test-model', apiKey: 'old-key', weight: 1 };
    setConfig(config);

    const addr = app.server.address();
    assert.ok(addr && typeof addr === 'object', 'server should have address');
    const baseUrl = `http://127.0.0.1:${(addr as { port: number }).port}`;

    // PATCH: update the model and apiKey
    const patchRes = await fetch(`${baseUrl}/providers/${testProvider}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'updated-model', apiKey: 'new-key', enabled: false }),
    });
    assert.equal(patchRes.status, 200);
    const patchBody = await patchRes.json() as { ok: boolean; provider: { enabled: boolean; model: string } };
    assert.equal(patchBody.ok, true);
    assert.equal(patchBody.provider.model, 'updated-model');
    assert.equal(patchBody.provider.enabled, false);

    // DELETE: remove the provider
    const deleteRes = await fetch(`${baseUrl}/providers/${testProvider}`, { method: 'DELETE' });
    assert.equal(deleteRes.status, 200);
    const deleteBody = await deleteRes.json() as { ok: boolean; removed: string };
    assert.equal(deleteBody.ok, true);
    assert.equal(deleteBody.removed, testProvider);

    // DELETE should 404 on already-deleted provider
    const delete2Res = await fetch(`${baseUrl}/providers/${testProvider}`, { method: 'DELETE' });
    assert.equal(delete2Res.status, 404);
  } finally {
    // Cleanup: close server and remove test provider
    const finalCfg = config;
    delete finalCfg.providers[`test-prov-${suffix}`];
    setConfig(finalCfg);
    await app.close();
  }
});

test('PATCH /providers/:name returns 404 for unknown provider', async () => {
  const config = await loadConfig();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const app = await createServer({
    serviceId: `gateway-prov-404-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });

  try {
    const addr = app.server.address();
    assert.ok(addr && typeof addr === 'object');
    const baseUrl = `http://127.0.0.1:${(addr as { port: number }).port}`;

    const res = await fetch(`${baseUrl}/providers/nonexistent-${suffix}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(res.status, 404);
  } finally {
    await app.close();
  }
});
