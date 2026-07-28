import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createStreamCheckpoint,
  _getLatestStreamCheckpoint,
  _getStreamCheckpointById,
  setStreamCheckpointBaseDir,
} from './stream-checkpoints.js';

test('stream checkpoint lookup returns latest and exact file-log records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'los-stream-latest-'));
  const sessionId = `stream-latest-${Date.now()}`;
  setStreamCheckpointBaseDir(root);

  try {
    await createStreamCheckpoint({
      sessionId,
      runSpecId: 'run-latest',
      turn: 1,
      eventType: 'model.delta',
      payload: { textDelta: 'first' },
    });
    const checkpoint = await createStreamCheckpoint({
      sessionId,
      runSpecId: 'run-latest',
      turn: 2,
      eventType: 'session.recovery.checkpoint',
      payload: {
        toolState: { pendingCalls: [], lastResult: [] },
        fileReferences: [],
        messageCursor: { lastEventId: '12', lastEventIndex: 12, turnCount: 2 },
      },
    });
    await createStreamCheckpoint({
      sessionId,
      runSpecId: 'run-latest',
      turn: 2,
      eventType: 'model.delta',
      payload: { textDelta: 'after checkpoint' },
    });

    const latest = await _getLatestStreamCheckpoint(sessionId);
    const exact = await _getStreamCheckpointById(sessionId, checkpoint.id);

    assert.equal(latest?.id, checkpoint.id);
    assert.equal(latest?.turn, 2);
    assert.equal(exact?.id, checkpoint.id);
    assert.equal(exact?.payload.messageCursor && typeof exact.payload.messageCursor, 'object');
  } finally {
    await rm(root, { recursive: true, force: true });
    setStreamCheckpointBaseDir(join(process.cwd(), '.los', 'streams'));
  }
});
