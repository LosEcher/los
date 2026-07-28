import test from 'node:test';
import assert from 'node:assert/strict';

import {
  _snapshotRecoveryCheckpoint,
  _trackRequestedToolCall,
  _updateToolStateCache,
} from './chat-service-hooks.js';

test('tool transition events move the payload entity id from pending to results', () => {
  const sessionId = `tool-state-${Date.now()}-${Math.random()}`;
  _trackRequestedToolCall(sessionId, 'call-1', 'read_file', { path: 'src/a.ts' }, 2);

  _updateToolStateCache(sessionId, {
    id: 40,
    turn: 2,
    type: 'tool_call_state.updated',
    payload: { entityId: 'call-1', to: 'running' },
  });
  _updateToolStateCache(sessionId, {
    id: 41,
    turn: 2,
    type: 'tool_call_state.updated',
    payload: { entityId: 'call-1', to: 'succeeded', reason: 'read completed' },
  });

  const checkpoint = _snapshotRecoveryCheckpoint(sessionId);
  assert.deepEqual(checkpoint?.toolState.pendingCalls, []);
  assert.deepEqual(checkpoint?.toolState.lastResult, [{
    callId: 'call-1',
    toolName: 'read_file',
    outcome: 'success',
    resultSummary: 'read completed',
  }]);
  assert.deepEqual(checkpoint?.messageCursor, {
    lastEventId: '41',
    lastEventIndex: 41,
    turnCount: 1,
  });
});

test('recovery checkpoint snapshots do not share mutable tool arguments', () => {
  const sessionId = `tool-state-clone-${Date.now()}-${Math.random()}`;
  _trackRequestedToolCall(sessionId, 'call-2', 'write_file', { path: 'src/b.ts' }, 1);

  const first = _snapshotRecoveryCheckpoint(sessionId);
  first!.toolState.pendingCalls[0]!.args.path = 'mutated.ts';
  const second = _snapshotRecoveryCheckpoint(sessionId);

  assert.equal(second?.toolState.pendingCalls[0]?.args.path, 'src/b.ts');
});
