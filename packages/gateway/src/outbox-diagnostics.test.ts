import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import { getDb } from '@los/infra/db';
import { createServer } from './server.js';
import { registerDiagnosticsRoutes } from './routes/infrastructure/diagnostics-routes.js';

test('gateway health includes execution outbox backlog evidence', async () => {
  const app = await createServer({
    serviceId: 'gateway-outbox-health-test',
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      outbox: Record<string, unknown> | null;
      cbmSymbolCache: Record<string, unknown>;
    };
    assert.equal(typeof body.outbox?.pendingCount, 'number');
    assert.equal(typeof body.outbox?.legacyCount, 'number');
    assert.equal(typeof body.outbox?.oldestPendingAgeMs, 'number');
    assert.equal(typeof body.cbmSymbolCache.activeSessions, 'number');
    assert.equal(typeof body.cbmSymbolCache.lateWriteDrops, 'number');
  } finally {
    await app.close();
  }
});

test('CBM cache diagnostics exposes bounded-cache metrics', async () => {
  const app = Fastify({ logger: false });
  registerDiagnosticsRoutes(app);
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
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `outbox-diagnostics-${suffix}`;
  registerDiagnosticsRoutes(app);

  try {
    const inserted = await getDb().query<{ id: string | number }>(`
      INSERT INTO execution_outbox (
        session_id, entity_type, entity_id, event_type, session_event_id, payload_json, legacy
      ) VALUES
        ($1, 'task_run', $2, 'task_run.running', 101, '{}'::jsonb, FALSE),
        ($1, 'task_run', $2, 'task_run.running', 100, '{}'::jsonb, TRUE)
      RETURNING id
    `, [sessionId, `${sessionId}-entity`]);

    const response = await app.inject({ method: 'GET', url: '/diagnostics/outbox' });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { outbox: Record<string, unknown> };
    assert.equal(body.outbox.pendingCount, 1);
    assert.equal(body.outbox.legacyCount, 1);
    assert.equal(body.outbox.legacyThroughId, Number(inserted.rows[1]?.id));
  } finally {
    await app.close();
    await getDb().query('DELETE FROM execution_outbox WHERE session_id = $1', [sessionId]).catch(() => undefined);
  }
});
