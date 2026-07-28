import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findRecoveryCheckpoint,
  type CompactionCheckpointRow,
  type RecoveryCheckpointSources,
} from './session-recovery-checkpoints.js';
import type { StreamCheckpointRecord } from './stream-checkpoints.js';

const sessionId = 'session-recovery-selection';

function compaction(id: string, createdAt: string): CompactionCheckpointRow {
  return {
    id,
    session_id: sessionId,
    run_spec_id: 'run-1',
    summary_json: {
      toolState: { pendingCalls: [], lastResult: [] },
      fileReferences: [],
      messageCursor: { lastEventId: '7', lastEventIndex: 7, turnCount: 2 },
    },
    created_at: createdAt,
    auto_trigger: 'manual',
  };
}

function stream(id: number, createdAt: string): StreamCheckpointRecord {
  return {
    id,
    sessionId,
    runSpecId: 'run-1',
    turn: 3,
    eventType: 'session.recovery.checkpoint',
    payload: {
      toolState: { pendingCalls: [], lastResult: [] },
      fileReferences: [],
      messageCursor: { lastEventId: '8', lastEventIndex: 8, turnCount: 3 },
    },
    createdAt,
  };
}

function sources(input: {
  latestCompaction?: CompactionCheckpointRow | null;
  latestStream?: StreamCheckpointRecord | null;
  compactions?: Map<string, CompactionCheckpointRow>;
  streams?: Map<number, StreamCheckpointRecord>;
}): RecoveryCheckpointSources {
  return {
    getLatestCompaction: async () => input.latestCompaction ?? null,
    getCompactionById: async (_sid, id) => input.compactions?.get(id) ?? null,
    getLatestStream: async () => input.latestStream ?? null,
    getStreamById: async (_sid, id) => input.streams?.get(id) ?? null,
  };
}

test('recovery selects the newest checkpoint across compaction and stream sources', async () => {
  const selected = await findRecoveryCheckpoint(sessionId, undefined, sources({
    latestCompaction: compaction('chkpt-old', '2026-07-28T01:00:00.000Z'),
    latestStream: stream(9, '2026-07-28T02:00:00.000Z'),
  }));

  assert.equal(selected?.checkpointId, `stream-${sessionId}-9`);
});

test('recovery uses an available stream checkpoint when compaction lookup fails', async () => {
  const fallbackSources = sources({ latestStream: stream(5, '2026-07-28T02:00:00.000Z') });
  fallbackSources.getLatestCompaction = async () => { throw new Error('database unavailable'); };

  const selected = await findRecoveryCheckpoint(sessionId, undefined, fallbackSources);

  assert.equal(selected?.checkpointId, `stream-${sessionId}-5`);
});

test('recovery honors an exact compaction checkpoint target', async () => {
  const target = compaction('chkpt-target', '2026-07-28T01:00:00.000Z');
  const selected = await findRecoveryCheckpoint(sessionId, target.id, sources({
    compactions: new Map([[target.id, target]]),
    latestStream: stream(99, '2026-07-28T03:00:00.000Z'),
  }));

  assert.equal(selected?.checkpointId, target.id);
  assert.equal(selected?.messageCursor.lastEventIndex, 7);
});

test('recovery honors an exact stream checkpoint target', async () => {
  const target = stream(4, '2026-07-28T01:00:00.000Z');
  const checkpointId = `stream-${sessionId}-${target.id}`;
  const selected = await findRecoveryCheckpoint(sessionId, checkpointId, sources({
    streams: new Map([[target.id, target]]),
  }));

  assert.equal(selected?.checkpointId, checkpointId);
  assert.equal(selected?.messageCursor.lastEventIndex, 8);
});

test('recovery rejects ordinary stream events that are not checkpoint snapshots', async () => {
  const ordinary = stream(6, '2026-07-28T01:00:00.000Z');
  ordinary.eventType = 'model.delta';
  ordinary.payload = { textDelta: 'partial output' };

  const selected = await findRecoveryCheckpoint(sessionId, undefined, sources({ latestStream: ordinary }));

  assert.equal(selected, null);
});

test('compaction timestamps are normalized to contract date-time strings', async () => {
  const target = compaction('chkpt-date', '2026-07-28T01:00:00.000Z');
  target.created_at = new Date(target.created_at);

  const selected = await findRecoveryCheckpoint(sessionId, undefined, sources({ latestCompaction: target }));

  assert.equal(selected?.takenAt, '2026-07-28T01:00:00.000Z');
});

test('recovery fails closed when the requested checkpoint is missing', async () => {
  const selected = await findRecoveryCheckpoint(
    sessionId,
    'chkpt-missing',
    sources({ latestStream: stream(10, '2026-07-28T03:00:00.000Z') }),
  );

  assert.equal(selected, null);
});
