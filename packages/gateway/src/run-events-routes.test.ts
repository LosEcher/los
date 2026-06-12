import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  appendSessionEvent,
  createStreamCheckpoint,
  ensureStreamCheckpointStore,
  createToolCallState,
  createVerificationRecord,
  createRunSpec,
  ensureRunSpecStore,
  ensureSessionEventStore,
  loadRunSpec,
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

test('run operation routes expose inspect, recover, and verify surfaces', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `run-ops-${suffix}`;
  const sessionId = `session-run-ops-${suffix}`;
  const taskRunId = `task-run-ops-${suffix}`;
  const toolCallId = `tool-run-ops-${suffix}`;
  const verificationId = `verification-run-ops-${suffix}`;
  const app = await createServer({
    serviceId: `gateway-run-ops-test-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });

  try {
    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'operate on run',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      maxLoops: 1,
    });
    await createToolCallState({
      id: toolCallId,
      sessionId,
      runSpecId,
      taskRunId,
      turn: 1,
      toolName: 'read_file',
      state: 'failed',
      inputJson: { path: 'AGENTS.md' },
      maxAttempts: 2,
      idempotent: true,
    });
    await createVerificationRecord({
      id: verificationId,
      sessionId,
      runSpecId,
      taskRunId,
      checkName: 'verify ok',
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('verify ok')")}`,
      status: 'required',
    });

    const inspect = await app.inject({
      method: 'GET',
      url: `/runs/${runSpecId}/inspect`,
    });
    assert.equal(inspect.statusCode, 200);
    assert.equal(inspect.json().runSpecId, runSpecId);
    assert.equal(inspect.json().state.phase, 'created');
    assert.equal(inspect.json().state.action, 'recover_tools');

    const state = await app.inject({
      method: 'GET',
      url: `/runs/${runSpecId}/state`,
    });
    assert.equal(state.statusCode, 200);
    assert.equal(state.json().runSpecId, runSpecId);
    assert.equal(state.json().action, 'recover_tools');
    assert.deepEqual(state.json().ids.failedVerificationRecordIds, []);

    const recover = await app.inject({
      method: 'POST',
      url: `/runs/${runSpecId}/recover`,
      payload: {},
    });
    assert.equal(recover.statusCode, 200);
    assert.equal(recover.json().recommendation, 'retry');

    const verify = await app.inject({
      method: 'POST',
      url: `/runs/${runSpecId}/verify`,
      payload: { timeoutMs: 30_000 },
    });
    assert.equal(verify.statusCode, 200);
    const verifyBody = verify.json();
    assert.equal(verifyBody.runSpecId, runSpecId);
    assert.deepEqual(verifyBody.ranRecordIds, [verificationId]);
    assert.equal(verifyBody.decision.status, 'succeeded');

    const transition = await app.inject({
      method: 'POST',
      url: `/runs/${runSpecId}/recover`,
      payload: { apply: true, intent: 'operator-attention', reason: 'route test attention' },
    });
    assert.equal(transition.statusCode, 200);
    assert.equal(transition.json().action, 'operator_attention');
    assert.equal(transition.json().runSpecStatus, 'blocked');
    assert.equal((await loadRunSpec(runSpecId))?.status, 'blocked');

    const missing = await app.inject({
      method: 'GET',
      url: `/runs/${runSpecId}-missing/inspect`,
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await getDb().query('DELETE FROM execution_outbox WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM tool_call_states WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await app.close();
    await closeDb().catch(() => undefined);
  }
});

test('run stream route interleaves stream checkpoints and session events', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `run-stream-${suffix}`;
  const sessionId = `session-run-stream-${suffix}`;
  const app = await createServer({
    serviceId: `gateway-run-stream-test-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });

  try {
    await ensureRunSpecStore();
    await ensureSessionEventStore();
    await ensureStreamCheckpointStore();
    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'stream replay test',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      maxLoops: 1,
    });

    // Insert a session event first
    const event1 = await appendSessionEvent({
      sessionId,
      type: 'session.started',
      payload: { runSpecId },
    });

    // Insert a stream checkpoint (model.delta)
    const delta = await createStreamCheckpoint({
      sessionId,
      runSpecId,
      turn: 1,
      eventType: 'model.delta',
      payload: { textDelta: 'Hello world', provider: 'deepseek' },
    });

    // Insert another session event
    const event2 = await appendSessionEvent({
      sessionId,
      type: 'model.response',
      model: 'deepseek-v4',
      turn: 1,
      payload: { textPreview: 'Hello world' },
    });

    // Insert another stream checkpoint (tool.call.upsert)
    const tool = await createStreamCheckpoint({
      sessionId,
      runSpecId,
      eventType: 'tool.call.upsert',
      payload: { callId: 'call-1', toolName: 'read_file', status: 'running', argsPreview: '{"path":"foo.txt"}' },
    });

    // Fetch stream replay from cursor 0
    const replay = await app.inject({
      method: 'GET',
      url: `/runs/${runSpecId}/stream?since=0&streamSince=0&limit=20`,
    });
    assert.equal(replay.statusCode, 200);
    const body = replay.json();
    assert.equal(body.runSpecId, runSpecId);
    assert.equal(body.sessionId, sessionId);
    assert.equal(body.count, 4);
    assert.equal(body.nextSince, event2.id);
    assert.equal(body.nextStreamSince, tool.id);

    // Items should be interleaved by createdAt order
    const items = body.items as Array<{ kind: string; eventType?: string; type?: string; id: number }>;
    assert.equal(items.length, 4);

    // First should be session.started event (inserted first)
    assert.equal(items[0].kind, 'event');
    assert.equal(items[0].type, 'session.started');

    // Verify stream checkpoints are present
    const streamItems = items.filter(i => i.kind === 'stream');
    assert.equal(streamItems.length, 2);
    assert.equal(streamItems[0].eventType, 'model.delta');
    assert.equal(streamItems[1].eventType, 'tool.call.upsert');

    const eventItems = items.filter(i => i.kind === 'event');
    assert.equal(eventItems.length, 2);

    // Replay with since cursor only (streamSince defaults to 0)
    const replayFromEvent2 = await app.inject({
      method: 'GET',
      url: `/runs/${runSpecId}/stream?since=${event2.id}&limit=20`,
    });
    assert.equal(replayFromEvent2.statusCode, 200);

    // Missing run spec returns 404
    const missing = await app.inject({
      method: 'GET',
      url: `/runs/${runSpecId}-missing/stream`,
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await getDb().query('DELETE FROM stream_checkpoints WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await app.close();
    await closeDb().catch(() => undefined);
  }
});
