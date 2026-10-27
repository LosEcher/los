import test from 'node:test';
import assert from 'node:assert/strict';

import { isMidTurnDrain } from './operator-control-consumer.js';
import type { SessionEventRecord } from './session-events.js';

function steering(drainMode?: string): SessionEventRecord {
  return {
    id: 1,
    sessionId: 's',
    turn: 1,
    type: 'operator.steering',
    source: 'los',
    payload: drainMode === undefined ? {} : { instruction: 'x', drainMode },
    visibility: 'audit',
    createdAt: '2026-10-18T00:00:00.000Z',
  };
}

test('immediate and finish_current_tool drain inside the turn', () => {
  assert.equal(isMidTurnDrain(steering('immediate')), true);
  assert.equal(isMidTurnDrain(steering('finish_current_tool')), true);
});

test('finish_current_turn and next_turn stay at the turn boundary', () => {
  assert.equal(isMidTurnDrain(steering('finish_current_turn')), false);
  assert.equal(isMidTurnDrain(steering('next_turn')), false);
});

test('a steering event without a drain mode uses the recorded default', () => {
  assert.equal(isMidTurnDrain(steering()), false);
});
