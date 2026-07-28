import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  _buildHandoffMessage,
  buildMessagesFromEvents,
  classifyRecoveryMode,
  countLostToolResults,
  detectStaleFiles,
} from './session-recovery-context.js';
import type { CheckpointSnapshot } from './session-recovery.js';
import type { SessionEventRecord } from './session-events.js';

function checkpoint(overrides: Partial<CheckpointSnapshot> = {}): CheckpointSnapshot {
  return {
    checkpointId: 'chkpt-1',
    sessionId: 'session-1',
    runSpecId: 'run-1',
    takenAt: '2026-07-28T01:00:00.000Z',
    trigger: 'manual',
    mode: 'checkpoint',
    toolState: { pendingCalls: [], lastResult: [] },
    fileReferences: [],
    messageCursor: { lastEventId: '1', lastEventIndex: 1, turnCount: 1 },
    ...overrides,
  };
}

function event(
  id: number,
  type: string,
  payload: Record<string, unknown>,
  toolName?: string,
): SessionEventRecord {
  return {
    id,
    sessionId: 'session-1',
    turn: 1,
    type,
    source: 'loop',
    toolName,
    payload,
    visibility: 'public',
    createdAt: `2026-07-28T01:00:0${id}.000Z`,
  };
}

test('handoff message includes checkpoint work and referenced files', () => {
  const message = _buildHandoffMessage('session-1', checkpoint({
    toolState: {
      pendingCalls: [{ callId: 'call-2', toolName: 'write_file', args: {}, status: 'running' }],
      lastResult: [{ callId: 'call-1', toolName: 'read_file', outcome: 'success', resultSummary: 'read src/a.ts' }],
    },
    fileReferences: [{ path: 'src/a.ts', contentHash: 'abc', lastOperation: 'read' }],
  }));

  assert.equal(message.role, 'system');
  assert.match(String(message.content), /checkpoint chkpt-1/);
  assert.match(String(message.content), /read_file: read src\/a\.ts/);
  assert.match(String(message.content), /write_file \(running\)/);
  assert.match(String(message.content), /src\/a\.ts \(read\)/);
});

test('message reconstruction preserves event order and completed tool results', () => {
  const messages = buildMessagesFromEvents('session-1', checkpoint(), [
    event(2, 'session.resumed', { content: 'resume marker' }),
    event(3, 'user.message', { content: 'inspect the file' }),
    event(4, 'model.turn.completed', { textPreview: 'I will inspect it' }),
    event(5, 'tool.call', { callId: 'call-1', args: { path: 'src/a.ts' } }, 'read_file'),
    event(6, 'tool.result', { callId: 'call-1', contentPreview: 'file contents' }, 'read_file'),
  ], true);

  assert.deepEqual(messages.map(message => message.role), [
    'system', 'system', 'user', 'assistant', 'assistant', 'tool',
  ]);
  assert.equal(messages.at(-1)?.content, 'file contents');
  assert.equal(countLostToolResults(messages, checkpoint()), 0);
});

test('missing tool result is stubbed and counted once with matching pending state', () => {
  const activeCheckpoint = checkpoint({
    toolState: {
      pendingCalls: [{ callId: 'call-1', toolName: 'read_file', args: {}, status: 'running' }],
      lastResult: [],
    },
  });
  const messages = buildMessagesFromEvents('session-1', activeCheckpoint, [
    event(2, 'tool.call', { callId: 'call-1', args: {} }, 'read_file'),
  ], true);

  assert.match(String(messages.at(-1)?.content), /Tool result lost/);
  assert.equal(countLostToolResults(messages, activeCheckpoint), 1);
  assert.equal(classifyRecoveryMode(1, 0, activeCheckpoint), 'partial');
});

test('recovery mode distinguishes intact, partial, and degraded recovery', () => {
  const intact = checkpoint();
  assert.equal(classifyRecoveryMode(0, 0, intact), 'full');
  assert.equal(classifyRecoveryMode(1, 0, intact), 'partial');
  assert.equal(classifyRecoveryMode(0, 3, intact), 'degraded');
});

test('stale file detection covers unchanged, modified, and deleted files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'los-recovery-files-'));
  const unchangedPath = join(root, 'unchanged.ts');
  const modifiedPath = join(root, 'modified.ts');
  const deletedPath = join(root, 'deleted.ts');
  const original = 'export const value = 1;\n';
  const originalHash = createHash('sha256').update(original).digest('hex');

  try {
    await Promise.all([
      writeFile(unchangedPath, original),
      writeFile(modifiedPath, 'export const value = 2;\n'),
      writeFile(deletedPath, original),
    ]);
    await unlink(deletedPath);
    const results = await detectStaleFiles([
      { path: unchangedPath, contentHash: originalHash, lastOperation: 'read' },
      { path: modifiedPath, contentHash: originalHash, lastOperation: 'edit' },
      { path: deletedPath, contentHash: originalHash, lastOperation: 'read' },
    ]);

    assert.deepEqual(results.map(result => result.stale), [false, true, true]);
    assert.equal(results[0]?.currentHash, originalHash);
    assert.equal(results[2]?.currentHash, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
