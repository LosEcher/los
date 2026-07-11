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
  config.integrations.feedAnalysis.serviceToken = TEST_TOKEN;
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
  config.integrations.feedAnalysis.serviceToken = TEST_TOKEN;
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
  config.integrations.feedAnalysis.serviceToken = TEST_TOKEN;
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
    assert.equal(response.statusCode, 202);
    const body = response.json();
    assert.ok(body.data, 'response should have data envelope');
    assert.ok(body.data.dispatch, 'should have dispatch receipt');
    assert.equal(body.data.dispatch.status, 'queued');
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
    assert.equal(replayResponse.statusCode, 202);
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
  config.integrations.feedAnalysis.serviceToken = TEST_TOKEN;
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
    assert.equal(response.json().error, 'invalid_request');
    assert.match(response.json().message, /required/);
  } finally {
    await app.close();
    await closeDb();
  }
});

test('integration routes: cancel is idempotent and result reflects cancellation', async () => {
  const config = await loadConfig();
  config.auth.enabled = true;
  config.auth.token = TEST_TOKEN;
  config.integrations.feedAnalysis.serviceToken = TEST_TOKEN;
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dispatchId = `fa-cancel-route-${suffix}`;
  await getDb().query(`
    INSERT INTO feed_analysis_dispatches (
      id, tenant_id, project_id, source_system, source_job_id, delivery_mode,
      contract_version, input_digest, idempotency_key, status
    ) VALUES ($1, 'local', 'los', 'lot2extension', $2, 'result_returning',
      'feed-analysis-v2', $3, $4, 'accepted')
  `, [dispatchId, `job-${suffix}`, `digest-${suffix}`, `idem-${suffix}`]);
  const app = await createServer({
    serviceId: `integration-cancel-test-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/integrations/feed-analysis/dispatch/${dispatchId}/cancel`,
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
        payload: { reason: 'fixture cancellation' },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().data.status, 'cancelled');
    }
    const resultResponse = await app.inject({
      method: 'GET',
      url: `/api/integrations/feed-analysis/dispatch/${dispatchId}/result`,
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(resultResponse.statusCode, 200);
    assert.equal(resultResponse.json().data.resultAvailable, false);
    assert.equal(resultResponse.json().data.status, 'cancelled');
  } finally {
    await app.close();
    await getDb().query('DELETE FROM feed_analysis_dispatches WHERE id=$1', [dispatchId]);
    await closeDb();
  }
});

test('integration routes: callback dead letters can be listed and replayed', async () => {
  const config = await loadConfig();
  config.auth.enabled = true;
  config.auth.token = TEST_TOKEN;
  config.integrations.feedAnalysis.serviceToken = TEST_TOKEN;
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dispatchId = `fa-dead-letter-route-${suffix}`;
  const eventId = `faevt-route-${suffix}`;
  const deliveryId = `fadel-route-${suffix}`;
  await getDb().query(`
    INSERT INTO feed_analysis_dispatches (
      id, tenant_id, project_id, source_system, source_job_id, delivery_mode,
      contract_version, input_digest, idempotency_key, status
    ) VALUES ($1, 'local', 'los', 'lot2extension', $2, 'result_returning', 'feed-analysis-v2', $3, $4, 'failed')
  `, [dispatchId, `job-${suffix}`, `digest-${suffix}`, `idem-${suffix}`]);
  await getDb().query(`
    INSERT INTO feed_analysis_callback_events (event_id, dispatch_id, sequence, event_version, status, payload_json, payload_digest)
    VALUES ($1, $2, 1, 'feed-analysis-result-v1', 'failed', '{}'::jsonb, $3)
  `, [eventId, dispatchId, `event-digest-${suffix}`]);
  await getDb().query(`
    INSERT INTO feed_analysis_callback_deliveries (id, event_id, profile_id, status, attempt_count, dead_lettered_at)
    VALUES ($1, $2, 'fixture', 'dead_letter', 8, now())
  `, [deliveryId, eventId]);
  const app = await createServer({
    serviceId: `integration-dead-letter-test-${suffix}`,
    bindUrl: 'http://127.0.0.1:0', publicUrl: 'http://127.0.0.1:0', hostLabel: 'test',
  });
  try {
    const listResponse = await app.inject({
      method: 'GET', url: '/api/integrations/feed-analysis/callbacks/dead-letter',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(listResponse.statusCode, 200);
    assert.ok(listResponse.json().data.deliveries.some((item: { id: string }) => item.id === deliveryId));
    const replayResponse = await app.inject({
      method: 'POST', url: `/api/integrations/feed-analysis/callbacks/${deliveryId}/replay`,
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(replayResponse.statusCode, 200);
    assert.equal(replayResponse.json().data.replayed, true);
  } finally {
    await app.close();
    await getDb().query('DELETE FROM feed_analysis_dispatches WHERE id=$1', [dispatchId]);
    await closeDb();
  }
});

test('integration routes: GET dispatch returns 404 for unknown id', async () => {
  const config = await loadConfig();
  config.auth.enabled = true;
  config.auth.token = TEST_TOKEN;
  config.integrations.feedAnalysis.serviceToken = TEST_TOKEN;
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
