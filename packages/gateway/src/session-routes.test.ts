import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  ensureSessionEventStore,
  ensureSessionStore,
  listSessionEvents,
  saveSession,
} from '@los/agent';
import { createServer } from './server.js';

test('POST /sessions/:id/operator-events persists steering and followup events', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-operator-route-${suffix}`;
  const idempotencyKey = `telegram-callback-${suffix}`;
  const app = await createServer({
    serviceId: `gateway-session-operator-test-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });

  try {
    await ensureSessionStore();
    await ensureSessionEventStore();
    await saveSession({
      id: sessionId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
      turns: [],
      metadata: {},
    });

    const steering = await app.inject({
      method: 'POST',
      url: `/sessions/${sessionId}/operator-events`,
      headers: {
        'x-request-id': `request-${suffix}`,
        'x-trace-id': `trace-${suffix}`,
        'x-tenant-id': 'tenant-route',
        'x-project-id': 'project-route',
        'x-user-id': 'operator-route',
      },
      payload: {
        type: 'steering',
        instruction: 'Finish current tool, then stop editing.',
        runSpecId: `run-${suffix}`,
        taskRunId: `task-${suffix}`,
        actor: 'spoofed-body-actor',
        reason: 'operator correction',
        turnBoundary: 'next_turn',
        drainMode: 'finish_current_tool',
      },
    });
    assert.equal(steering.statusCode, 200);
    assert.equal(steering.json().event.type, 'operator.steering');
    assert.equal(steering.json().event.payload.actor, 'operator:local');

    const followup = await app.inject({
      method: 'POST',
      url: `/sessions/${sessionId}/operator-events`,
      payload: {
        type: 'followup',
        prompt: 'Run the focused gateway test.',
        parentSessionId: `parent-${suffix}`,
      },
    });
    assert.equal(followup.statusCode, 200);
    assert.equal(followup.json().event.type, 'operator.followup');

    const events = await listSessionEvents(sessionId);
    assert.deepEqual(events.map((event) => event.type), ['operator.steering', 'operator.followup']);
    assert.equal(events[0]?.tenantId, 'tenant-route');
    assert.equal(events[0]?.projectId, 'project-route');
    assert.equal(events[0]?.userId, 'operator-route');
    assert.equal(events[0]?.requestId, `request-${suffix}`);
    assert.equal(events[0]?.traceId, `trace-${suffix}`);
    assert.equal(events[0]?.payload.reason, 'operator correction');
    assert.equal(events[1]?.payload.parentSessionId, `parent-${suffix}`);

    const idempotentPayload = {
      type: 'steering',
      instruction: 'Approved via Telegram: callId=call-a',
      actor: 'spoofed-telegram-bot',
      reason: 'operator_approval',
      turnBoundary: 'immediate',
    };
    const idempotentHeaders = {
      'x-idempotency-key': idempotencyKey,
      'x-user-id': 'telegram:42',
    };
    const firstCallback = await app.inject({
      method: 'POST',
      url: `/sessions/${sessionId}/operator-events`,
      headers: idempotentHeaders,
      payload: idempotentPayload,
    });
    const replayedCallback = await app.inject({
      method: 'POST',
      url: `/sessions/${sessionId}/operator-events`,
      headers: idempotentHeaders,
      payload: idempotentPayload,
    });
    assert.equal(firstCallback.statusCode, 200);
    assert.equal(replayedCallback.statusCode, 200);
    assert.equal(firstCallback.headers['x-idempotency-status'], 'reserved');
    assert.equal(replayedCallback.headers['x-idempotency-status'], 'replayed');

    const afterReplay = await listSessionEvents(sessionId);
    const telegramEvents = afterReplay.filter(event => event.payload.reason === 'operator_approval');
    assert.equal(telegramEvents.length, 1);
    assert.equal(telegramEvents[0]?.payload.actor, 'operator:local');
    assert.equal(telegramEvents[0]?.userId, 'telegram:42');

    const missing = await app.inject({
      method: 'POST',
      url: `/sessions/${sessionId}-missing/operator-events`,
      payload: { type: 'steering', instruction: 'noop' },
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM sessions WHERE id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM idempotency_keys WHERE idempotency_key = $1', [idempotencyKey]).catch(() => undefined);
    await app.close();
    await closeDb().catch(() => undefined);
  }
});
