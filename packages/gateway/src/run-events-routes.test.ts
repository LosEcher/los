import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  appendSessionEvent,
  createRunSpec,
  ensureRunSpecStore,
  ensureSessionEventStore,
} from '@los/agent';
import { createServer } from './server.js';

test('run events route replays session events by run spec cursor', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `run-events-${suffix}`;
  const sessionId = `session-run-events-${suffix}`;
  const app = await createServer({
    serviceId: `gateway-run-events-test-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });

  try {
    await ensureRunSpecStore();
    await ensureSessionEventStore();
    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'replay run events',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      maxLoops: 1,
    });

    const first = await appendSessionEvent({
      sessionId,
      type: 'session.started',
      payload: { runSpecId },
    });
    const second = await appendSessionEvent({
      sessionId,
      type: 'model.response',
      model: 'test-model',
      turn: 1,
      payload: { textPreview: 'ok' },
    });
    await appendSessionEvent({
      sessionId,
      type: 'session.completed',
      payload: { runSpecId },
    });

    const replay = await app.inject({
      method: 'GET',
      url: `/runs/${runSpecId}/events?since=${first.id}&limit=1`,
    });
    assert.equal(replay.statusCode, 200);
    const body = replay.json();
    assert.equal(body.runSpecId, runSpecId);
    assert.equal(body.sessionId, sessionId);
    assert.equal(body.since, first.id);
    assert.equal(body.count, 1);
    assert.equal(body.nextSince, second.id);
    assert.equal(body.events[0].id, second.id);
    assert.equal(body.events[0].type, 'model.response');

    const missing = await app.inject({
      method: 'GET',
      url: `/runs/${runSpecId}-missing/events`,
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await app.close();
    await closeDb().catch(() => undefined);
  }
});
