import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  appendSessionEvent,
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
