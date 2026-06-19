import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import { closeDb, getDb, initDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import {
  ensureServiceInstanceStore,
  upsertServiceInstanceHeartbeat,
} from '@los/agent/service-instances';
import { registerServiceRoutes } from './routes/infrastructure/service-routes.js';

test('service routes expose liveness, readiness, and drain state', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const serviceId = `test-service-route-${Date.now()}`;
  const app = Fastify({ logger: false });
  registerServiceRoutes(app, { serviceId, serviceKind: 'gateway' });

  try {
    await ensureServiceInstanceStore();
    await upsertServiceInstanceHeartbeat({
      serviceId,
      serviceKind: 'gateway',
      health: { db_ok: true, schema_ok: true },
      capabilities: { chat_api: true },
    });

    const live = await app.inject({ method: 'GET', url: '/live' });
    assert.equal(live.statusCode, 200);
    assert.equal(live.json().serviceId, serviceId);

    const ready = await app.inject({ method: 'GET', url: '/ready' });
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.json().ready, true);

    const services = await app.inject({ method: 'GET', url: '/services' });
    assert.equal(services.statusCode, 200);
    assert.ok(services.json().some((item: { serviceId: string }) => item.serviceId === serviceId));

    const drain = await app.inject({
      method: 'POST',
      url: `/services/${serviceId}/drain`,
      payload: { reason: 'route test drain' },
    });
    assert.equal(drain.statusCode, 200);
    assert.equal(drain.json().service.status, 'draining');

    const notReady = await app.inject({ method: 'GET', url: '/ready' });
    assert.equal(notReady.statusCode, 503);
    assert.equal(notReady.json().ready, false);
    assert.ok(notReady.json().blockers.includes('status:draining'));

    const promote = await app.inject({
      method: 'POST',
      url: `/services/${serviceId}/promote`,
      payload: { reason: 'route test promote' },
    });
    assert.equal(promote.statusCode, 200);
    assert.equal(promote.json().service.status, 'online');
  } finally {
    await getDb().query('DELETE FROM service_instances WHERE service_id = $1', [serviceId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
    await app.close();
  }
});
