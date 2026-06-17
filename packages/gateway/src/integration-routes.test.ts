import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { createServer } from './server.js';

const TEST_TOKEN = 'test-integration-token';

test('integration routes: GET /api/integrations/feed-analysis/targets returns targets', async () => {
  const config = await loadConfig();
  config.auth.enabled = true;
  config.auth.token = TEST_TOKEN;
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const app = await createServer({
    serviceId: `integration-targets-test-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/integrations/feed-analysis/targets',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.ok(body.data, 'response should have data envelope');
    assert.ok(Array.isArray(body.data.targets), 'data.targets should be an array');
    assert.ok(body.data.targets.length >= 1, 'should have at least one target');
    const losTarget = body.data.targets.find((t: { kind: string }) => t.kind === 'los-ingress');
    assert.ok(losTarget, 'should have los-ingress target');
    assert.equal(losTarget.status, 'available');
    assert.ok(losTarget.supportedDeliveryModes.includes('delivery_only'));
    assert.ok(losTarget.supportedDeliveryModes.includes('result_returning'));
  } finally {
    await app.close();
    await closeDb();
  }
});

test('integration routes: targets rejects without auth', async () => {
  const config = await loadConfig();
  config.auth.enabled = true;
  config.auth.token = TEST_TOKEN;
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const app = await createServer({
    serviceId: `integration-noauth-test-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });

  try {
    // No auth header
    const noAuth = await app.inject({
      method: 'GET',
      url: '/api/integrations/feed-analysis/targets',
    });
    assert.equal(noAuth.statusCode, 401);

    // Wrong token
    const wrongToken = await app.inject({
      method: 'GET',
      url: '/api/integrations/feed-analysis/targets',
      headers: { authorization: 'Bearer wrong-token' },
    });
    assert.equal(wrongToken.statusCode, 401);
  } finally {
    await app.close();
    await closeDb();
  }
});

test('integration routes: POST dispatch creates run spec and returns receipt', async () => {
  const config = await loadConfig();
  config.auth.enabled = true;
  config.auth.token = TEST_TOKEN;
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const idempotencyKey = `test-key-${suffix}`;
  const app = await createServer({
    serviceId: `integration-dispatch-test-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/feed-analysis/dispatch',
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        'content-type': 'application/json',
        'x-idempotency-key': idempotencyKey,
      },
      payload: {
        sourceSystem: 'lot2extension',
        sourceJobId: `test-job-${suffix}`,
        sourceSessionId: `test-session-${suffix}`,
        deliveryMode: 'delivery_only',
        targetKind: 'los-ingress',
        feedSession: {
          platform: 'x',
          pageUrl: 'https://x.com/home',
          pageKind: 'home_feed',
          markReason: 'test',
        },
        feedObservations: [
          { platform: 'x', itemId: '123', titleOrCaption: 'Test tweet' },
          { platform: 'x', itemId: '456', titleOrCaption: 'Another tweet' },
        ],
      },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.ok(body.data, 'response should have data envelope');
    assert.ok(body.data.dispatch, 'should have dispatch receipt');
    assert.equal(body.data.dispatch.status, 'accepted');
    assert.ok(body.data.dispatch.runId, 'should have runId');
    assert.ok(body.data.dispatch.traceId, 'should have traceId');
    assert.equal(body.data.dispatchState.accepted, true);
    assert.equal(body.data.dispatchState.deliveryMode, 'delivery_only');
    assert.equal(body.data.deduplicated, false);

    // Query dispatch status
    const statusResponse = await app.inject({
      method: 'GET',
      url: `/api/integrations/feed-analysis/dispatch/${body.data.dispatch.id}`,
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(statusResponse.statusCode, 200);
    const statusBody = statusResponse.json();
    assert.equal(statusBody.data.dispatch.id, body.data.dispatch.id);

    // Idempotent replay: same key + same body returns existing cached response
    const replayResponse = await app.inject({
      method: 'POST',
      url: '/api/integrations/feed-analysis/dispatch',
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        'content-type': 'application/json',
        'x-idempotency-key': idempotencyKey,
      },
      payload: {
        sourceSystem: 'lot2extension',
        sourceJobId: `test-job-${suffix}`,
        sourceSessionId: `test-session-${suffix}`,
        deliveryMode: 'delivery_only',
        targetKind: 'los-ingress',
        feedSession: {
          platform: 'x',
          pageUrl: 'https://x.com/home',
          pageKind: 'home_feed',
          markReason: 'test',
        },
        feedObservations: [
          { platform: 'x', itemId: '123', titleOrCaption: 'Test tweet' },
          { platform: 'x', itemId: '456', titleOrCaption: 'Another tweet' },
        ],
      },
    });
    assert.equal(replayResponse.statusCode, 200);
    const replayBody = replayResponse.json();
    assert.equal(replayBody.data.deduplicated, true);
    assert.equal(replayBody.data.dispatch.id, body.data.dispatch.id);
  } finally {
    await app.close();
    await closeDb();
  }
});

test('integration routes: dispatch rejects missing required fields', async () => {
  const config = await loadConfig();
  config.auth.enabled = true;
  config.auth.token = TEST_TOKEN;
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const app = await createServer({
    serviceId: `integration-validation-test-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/feed-analysis/dispatch',
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        'content-type': 'application/json',
      },
      payload: { sourceSystem: 'lot2extension' },  // missing sourceJobId and deliveryMode
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /required/);
  } finally {
    await app.close();
    await closeDb();
  }
});

test('integration routes: GET dispatch returns 404 for unknown id', async () => {
  const config = await loadConfig();
  config.auth.enabled = true;
  config.auth.token = TEST_TOKEN;
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const app = await createServer({
    serviceId: `integration-404-test-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/integrations/feed-analysis/dispatch/nonexistent-id',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    await closeDb();
  }
});
