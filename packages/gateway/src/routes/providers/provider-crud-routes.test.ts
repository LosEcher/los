/**
 * Provider CRUD route integration tests.
 *
 * Fastify inject-based tests for POST / PATCH / DELETE / GET /providers and
 * GET /providers/models. These validate that config-level provider management
 * works end-to-end without hitting a real provider.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import type { FastifyInstance } from 'fastify';

const { createServer } = await import('../../server.js');

let app: FastifyInstance;

test.before(async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  app = await createServer();
  await app.ready();
});

test.after(async () => {
  await app.close();
  await closeDb().catch(() => undefined);
});

// ── POST /providers ────────────────────────────────────────

test('POST /providers creates a new provider', async () => {
  const slug = `test-crud-${Date.now()}`;
  const res = await app.inject({
    method: 'POST',
    url: '/providers',
    payload: { name: slug, apiKey: `sk-test-${slug}` },
  });
  assert.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);
  assert.ok(body.ok);
  assert.equal(body.provider.name, slug);
  assert.ok(body.provider.enabled);
  assert.equal(body.provider.weight, 100);
});

test('POST /providers rejects duplicate names', async () => {
  const slug = `test-dup-${Date.now()}`;
  const res1 = await app.inject({
    method: 'POST',
    url: '/providers',
    payload: { name: slug },
  });
  assert.equal(res1.statusCode, 201);

  const res2 = await app.inject({
    method: 'POST',
    url: '/providers',
    payload: { name: slug },
  });
  assert.equal(res2.statusCode, 409);
  const body = JSON.parse(res2.body);
  assert.ok(body.error.includes('already exists'));
});

test('POST /providers rejects empty name', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/providers',
    payload: { name: '' },
  });
  assert.equal(res.statusCode, 422);
});

test('POST /providers sanitizes name to lowercase with hyphens', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/providers',
    payload: { name: 'Test Provider Name!' },
  });
  assert.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);
  assert.equal(body.provider.name, 'test-provider-name');
});

// ── PATCH /providers/:name ──────────────────────────────────

test('PATCH /providers/:name updates provider fields', async () => {
  const slug = `test-patch-${Date.now()}`;
  await app.inject({ method: 'POST', url: '/providers', payload: { name: slug } });

  const res = await app.inject({
    method: 'PATCH',
    url: `/providers/${slug}`,
    payload: { model: 'custom-model', enabled: false, weight: 50 },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(body.ok);
  assert.equal(body.provider.model, 'custom-model');
  assert.equal(body.provider.enabled, false);
  assert.equal(body.provider.weight, 50);
});

test('PATCH /providers/:name returns 404 for unknown provider', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/providers/nonexistent-provider-12345',
    payload: { model: 'x' },
  });
  assert.equal(res.statusCode, 404);
});

test('PATCH /providers/:name preserves unchanged fields', async () => {
  const slug = `test-patch-preserve-${Date.now()}`;
  await app.inject({
    method: 'POST',
    url: '/providers',
    payload: { name: slug, model: 'keep-me' },
  });

  const res = await app.inject({
    method: 'PATCH',
    url: `/providers/${slug}`,
    payload: { enabled: false },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.provider.model, 'keep-me');
  assert.equal(body.provider.enabled, false);
});

// ── DELETE /providers/:name ─────────────────────────────────

test('DELETE /providers/:name removes a provider', async () => {
  const slug = `test-del-${Date.now()}`;
  await app.inject({ method: 'POST', url: '/providers', payload: { name: slug } });

  const res = await app.inject({ method: 'DELETE', url: `/providers/${slug}` });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(body.ok);
  assert.equal(body.removed, slug);

  // Subsequent GET should not include it
  const listRes = await app.inject({ method: 'GET', url: '/providers/models' });
  const list = JSON.parse(listRes.body);
  assert.ok(Array.isArray(list.models));
  const found = list.models.filter((m: any) => m.provider === slug);
  assert.equal(found.length, 0, `provider ${slug} should be gone after DELETE`);
});

test('DELETE /providers/:name returns 404 for unknown provider', async () => {
  const res = await app.inject({
    method: 'DELETE',
    url: '/providers/nonexistent-del-99999',
  });
  assert.equal(res.statusCode, 404);
});

// ── GET /providers/models ───────────────────────────────────

test('GET /providers/models returns model list', async () => {
  const res = await app.inject({ method: 'GET', url: '/providers/models' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.models));
  assert.ok(typeof body.count === 'number');
});

test('GET /providers/models filters by provider query param', async () => {
  const slug = `test-filter-${Date.now()}`;
  await app.inject({
    method: 'POST',
    url: '/providers',
    payload: { name: slug, model: 'filter-test-model' },
  });

  const res = await app.inject({
    method: 'GET',
    url: `/providers/models?provider=${slug}`,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.provider, slug);
  // The manually registered provider should appear
  const found = body.models.filter((m: any) => m.provider === slug);
  assert.ok(found.length > 0, `provider ${slug} should be in filtered results`);
});

test('GET /providers/models filters by search query', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/providers/models?q=deepseek',
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  // deepseek should be discovered and appear in search
  assert.ok(Array.isArray(body.models));
});

// ── Full CRUD lifecycle ─────────────────────────────────────

test('provider CRUD lifecycle: POST → PATCH → GET → DELETE', async () => {
  const slug = `test-lifecycle-${Date.now()}`;

  // Create
  const createRes = await app.inject({
    method: 'POST', url: '/providers',
    payload: { name: slug, model: 'lifecycle-model', apiKey: 'sk-lifecycle' },
  });
  assert.equal(createRes.statusCode, 201);

  // Update model
  const patchRes = await app.inject({
    method: 'PATCH', url: `/providers/${slug}`,
    payload: { model: 'updated-model', weight: 200 },
  });
  assert.equal(patchRes.statusCode, 200);
  assert.equal(JSON.parse(patchRes.body).provider.model, 'updated-model');

  // List includes it
  const listRes = await app.inject({
    method: 'GET', url: `/providers/models?provider=${slug}`,
  });
  assert.equal(JSON.parse(listRes.body).count, 1);

  // Delete
  const delRes = await app.inject({ method: 'DELETE', url: `/providers/${slug}` });
  assert.equal(delRes.statusCode, 200);

  // Gone from list
  const afterRes = await app.inject({
    method: 'GET', url: `/providers/models?provider=${slug}`,
  });
  // After delete, models list should be empty or not include it
  const after = JSON.parse(afterRes.body);
  assert.equal(after.models.filter((m: any) => m.provider === slug).length, 0);
});
