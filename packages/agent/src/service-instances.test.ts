import test from 'node:test';
import assert from 'node:assert/strict';

import { closeDb, getDb, initDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import {
  ensureServiceInstanceStore,
  loadServiceInstance,
  upsertServiceInstance,
  upsertServiceInstanceHeartbeat,
} from './service-instances.js';

test('service instance heartbeat records readiness inputs', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const serviceId = `test-gateway-${Date.now()}`;
  try {
    await ensureServiceInstanceStore();

    const service = await upsertServiceInstanceHeartbeat({
      serviceId,
      serviceKind: 'gateway',
      hostLabel: 'local-box',
      bindUrl: 'http://127.0.0.1:8080',
      publicUrl: 'http://127.0.0.1:8080',
      capabilities: {
        chat_api: true,
        service_registry: true,
      },
      health: {
        db_ok: true,
        schema_ok: true,
      },
      load: {
        active_requests: 0,
      },
      priority: 10,
    });

    assert.equal(service.status, 'online');
    assert.equal(service.readiness.ready, true);
    assert.equal(service.priority, 10);
    assert.equal(service.capabilities.chat_api, true);

    const loaded = await loadServiceInstance(serviceId);
    assert.equal(loaded?.hostLabel, 'local-box');
    assert.equal(loaded?.readiness.ready, true);
  } finally {
    await getDb().query('DELETE FROM service_instances WHERE service_id = $1', [serviceId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('service heartbeat preserves draining status until promoted', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const serviceId = `test-draining-gateway-${Date.now()}`;
  try {
    await ensureServiceInstanceStore();

    await upsertServiceInstanceHeartbeat({
      serviceId,
      serviceKind: 'gateway',
      status: 'online',
      health: { db_ok: true, schema_ok: true },
    });
    const draining = await upsertServiceInstance({
      serviceId,
      status: 'draining',
      rolloutState: 'draining',
      rolloutMessage: 'test drain',
    });
    assert.equal(draining.readiness.ready, false);
    assert.ok(draining.readiness.blockers.includes('status:draining'));

    const heartbeat = await upsertServiceInstanceHeartbeat({
      serviceId,
      serviceKind: 'gateway',
      health: { db_ok: true, schema_ok: true },
    });
    assert.equal(heartbeat.status, 'draining');

    const promoted = await upsertServiceInstance({
      serviceId,
      status: 'online',
      rolloutState: 'idle',
    });
    assert.equal(promoted.readiness.ready, true);
  } finally {
    await getDb().query('DELETE FROM service_instances WHERE service_id = $1', [serviceId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
