import test from 'node:test';
import assert from 'node:assert/strict';

import {
  recoveryCheckpointSummary,
  type RecoveryCheckpointInput,
} from './core/compaction-recovery.js';

test('recovery checkpoint fields round-trip into a compaction summary', () => {
  const checkpoint: RecoveryCheckpointInput = {
    toolState: {
      pendingCalls: [{
        callId: 'call-1',
        toolName: 'read_file',
        args: { path: 'src/a.ts' },
        status: 'running',
      }],
      lastResult: [{
        callId: 'call-0',
        toolName: 'search',
        outcome: 'success',
        resultSummary: '3 matches',
      }],
    },
    fileReferences: [{
      path: 'src/a.ts',
      contentHash: 'abc123',
      lastOperation: 'read',
    }],
    messageCursor: { lastEventId: '42', lastEventIndex: 42, turnCount: 3 },
  };

  const summary = recoveryCheckpointSummary(checkpoint);

  assert.deepEqual(summary, {
    toolState: checkpoint.toolState,
    fileReferences: checkpoint.fileReferences,
    messageCursor: checkpoint.messageCursor,
  });
  checkpoint.toolState.pendingCalls[0]!.args.path = 'mutated.ts';
  assert.equal(
    ((summary.toolState as RecoveryCheckpointInput['toolState']).pendingCalls[0]!.args.path),
    'src/a.ts',
  );
});

test('recovery checkpoint summary keeps only the ten most recent file references', () => {
  const checkpoint: RecoveryCheckpointInput = {
    toolState: { pendingCalls: [], lastResult: [] },
    fileReferences: Array.from({ length: 12 }, (_, index) => ({
      path: `src/${index}.ts`,
      contentHash: String(index),
      lastOperation: 'read' as const,
    })),
    messageCursor: { lastEventId: '1', lastEventIndex: 1, turnCount: 1 },
  };

  const summary = recoveryCheckpointSummary(checkpoint);
  const references = summary.fileReferences as RecoveryCheckpointInput['fileReferences'];
  assert.equal(references.length, 10);
  assert.equal(references[0]?.path, 'src/2.ts');
});
