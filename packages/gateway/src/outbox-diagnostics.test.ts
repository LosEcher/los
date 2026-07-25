import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import { registerDiagnosticsRoutes } from './routes/infrastructure/diagnostics-routes.js';
import type { DiagnosticsRouteDependencies } from './routes/infrastructure/diagnostics-routes.js';

// ── Stub deps: in-memory diagnostics data, no DB ──

const stubOutbox = { pendingCount: 1, legacyCount: 1, legacyThroughId: 42, oldestPendingAgeMs: 3600 };

const stubDeps: DiagnosticsRouteDependencies = {
  readExecutionOutboxHealth: async () => ({ pendingCount: 1, legacyCount: 1, legacyThroughId: 42, oldestPendingAgeMs: 3600, totalCount: 2, byEventType: {} }) as any,
  getRepairCounters: () => ({ total: 0, byProvider: {}, byType: {} }) as any,
  ensureSessionEventStore: async () => ({} as any),
  ensureProviderCallTelemetryStore: async () => ({} as any),
};

test('CBM cache diagnostics exposes bounded-cache metrics', async () => {
  const app = Fastify({ logger: false });
  registerDiagnosticsRoutes(app, stubDeps);
  try {
    const response = await app.inject({ method: 'GET', url: '/diagnostics/cbm-cache' });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { cache: Record<string, unknown> };
    assert.equal(typeof body.cache.activeSessions, 'number');
    assert.equal(typeof body.cache.expiredSessions, 'number');
    assert.equal(typeof body.cache.capacitySessionEvictions, 'number');
    assert.equal(typeof body.cache.maxCallsPerSession, 'number');
  } finally {
    await app.close();
  }
});

test('outbox diagnostics reports backlog and legacy watermark', async () => {
  const app = Fastify({ logger: false });
  registerDiagnosticsRoutes(app, stubDeps);

  try {
    const response = await app.inject({ method: 'GET', url: '/diagnostics/outbox' });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { outbox: Record<string, unknown> };
    assert.equal(body.outbox.pendingCount, 1);
    assert.equal(body.outbox.legacyCount, 1);
    assert.equal(body.outbox.legacyThroughId, 42);
  } finally {
    await app.close();
  }
});
