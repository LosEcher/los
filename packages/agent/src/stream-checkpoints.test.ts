import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  createStreamCheckpoint,
  ensureStreamCheckpointStore,
  listStreamCheckpointsSince,
  listStreamCheckpointsForRunSpec,
} from './stream-checkpoints.js';

test('stream checkpoints persist and replay by cursor', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-sc-${suffix}`;
  const runSpecId = `run-sc-${suffix}`;
  try {
    await ensureStreamCheckpointStore();

    // Create model.delta checkpoint
    const delta = await createStreamCheckpoint({
      sessionId,
      runSpecId,
      turn: 1,
      eventType: 'model.delta',
      payload: { textDelta: 'Hello', provider: 'deepseek', model: 'deepseek-v4' },
    });
    assert.equal(delta.sessionId, sessionId);
    assert.equal(delta.runSpecId, runSpecId);
    assert.equal(delta.turn, 1);
    assert.equal(delta.eventType, 'model.delta');
    assert.equal(delta.payload.textDelta, 'Hello');
    assert.ok(typeof delta.id === 'number' && delta.id > 0);

    // Create tool.call.upsert checkpoint
    const tool = await createStreamCheckpoint({
      sessionId,
      runSpecId,
      eventType: 'tool.call.upsert',
      payload: { callId: 'call-1', toolName: 'read_file', status: 'running', argsPreview: '{"path":"foo.txt"}' },
    });
    assert.equal(tool.eventType, 'tool.call.upsert');
    assert.equal(tool.payload.toolName, 'read_file');

    // Create turn checkpoint
    const turn = await createStreamCheckpoint({
      sessionId,
      runSpecId,
      turn: 1,
      eventType: 'turn',
      payload: { loopCount: 1, toolCallCount: 1, toolNames: ['read_file'] },
    });
    assert.equal(turn.eventType, 'turn');

    // Replay from cursor 0 — should return all three in order
    const all = await listStreamCheckpointsSince(sessionId, 0, 10);
    assert.equal(all.length, 3);
    assert.equal(all[0].eventType, 'model.delta');
    assert.equal(all[1].eventType, 'tool.call.upsert');
    assert.equal(all[2].eventType, 'turn');

    // Replay from delta's id — should skip delta
    const afterDelta = await listStreamCheckpointsSince(sessionId, delta.id, 10);
    assert.equal(afterDelta.length, 2);
    assert.equal(afterDelta[0].eventType, 'tool.call.upsert');

    // Replay with limit 1
    const limited = await listStreamCheckpointsSince(sessionId, 0, 1);
    assert.equal(limited.length, 1);
    assert.equal(limited[0].id, delta.id);

    // Empty since past last id
    const empty = await listStreamCheckpointsSince(sessionId, turn.id, 10);
    assert.equal(empty.length, 0);
  } finally {
    await getDb().query('DELETE FROM stream_checkpoints WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('stream checkpoints filter by run spec', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-sc2-${suffix}`;
  const runSpecA = `run-sca-${suffix}`;
  const runSpecB = `run-scb-${suffix}`;
  try {
    await ensureStreamCheckpointStore();

    await createStreamCheckpoint({
      sessionId, runSpecId: runSpecA, turn: 1,
      eventType: 'model.delta',
      payload: { textDelta: 'from A' },
    });
    await createStreamCheckpoint({
      sessionId, runSpecId: runSpecB, turn: 1,
      eventType: 'model.delta',
      payload: { textDelta: 'from B' },
    });
    await createStreamCheckpoint({
      sessionId, runSpecId: runSpecA, turn: 2,
      eventType: 'model.delta',
      payload: { textDelta: 'from A again' },
    });

    const byA = await listStreamCheckpointsForRunSpec(runSpecA, 0, 10);
    assert.equal(byA.length, 2);
    assert.equal(byA[0].payload.textDelta, 'from A');
    assert.equal(byA[1].payload.textDelta, 'from A again');

    const byB = await listStreamCheckpointsForRunSpec(runSpecB, 0, 10);
    assert.equal(byB.length, 1);
    assert.equal(byB[0].payload.textDelta, 'from B');

    const missing = await listStreamCheckpointsForRunSpec('nonexistent', 0, 10);
    assert.equal(missing.length, 0);
  } finally {
    await getDb().query('DELETE FROM stream_checkpoints WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('stream checkpoint with defaults works', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-sc3-${suffix}`;
  try {
    await ensureStreamCheckpointStore();

    const minimal = await createStreamCheckpoint({
      sessionId,
      eventType: 'tool.call.upsert',
    });
    assert.equal(minimal.sessionId, sessionId);
    assert.equal(minimal.runSpecId, undefined);
    assert.equal(minimal.turn, 0);
    assert.deepEqual(minimal.payload, {});
  } finally {
    await getDb().query('DELETE FROM stream_checkpoints WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
