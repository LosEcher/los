import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import { registerServiceRoutes } from './routes/infrastructure/service-routes.js';
import type { ServiceRoutesDependencies } from './routes/infrastructure/service-routes.js';

// ── Stub deps: in-memory service instance store, no DB ──

const stubStore = new Map<string, Record<string, unknown>>();

const stubDeps: ServiceRoutesDependencies = {
  ensureServiceInstanceStore: async () => ({} as any),
  listServiceInstances: async () => Array.from(stubStore.values()) as any,
  loadServiceInstance: async (id: string) => (stubStore.get(id) ?? null) as any,
  upsertServiceInstance: async (input: any) => {
    // Update readiness based on status transitions
    const status = input.status as string | undefined;
    const blockers: string[] = status === 'draining' ? ['status:draining'] : [];
    const warnings: string[] = [];
    if (input.status || input.rolloutState) {
      input.readiness = { blockers, warnings };
    }
    const existing = stubStore.get(input.serviceId);
    const merged = { ...existing, ...input };
    stubStore.set(input.serviceId, merged);
    return merged as any;
  },
};

test('service routes expose liveness, readiness, and drain state', async () => {
  const serviceId = `test-service-route-${Date.now()}`;
  const app = Fastify({ logger: false });
  registerServiceRoutes(app, { serviceId, serviceKind: 'gateway' }, stubDeps);

  // Stub: pre-populate with a healthy service instance
  stubStore.set(serviceId, {
    serviceId,
    serviceKind: 'gateway',
    status: 'online',
    health: { db_ok: true, schema_ok: true },
    capabilities: { chat_api: true },
    readiness: { blockers: [], warnings: [] },
  });

  try {
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
    await app.close();
  }
});
