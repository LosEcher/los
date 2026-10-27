import test from 'node:test';
import assert from 'node:assert/strict';

import type { SessionEventRecord } from '@los/agent/session-events';
import { foldSessionTrace } from '@los/agent/session-trace';
import { foldTraceWindow, readTraceSeed, resetTraceSeedCache } from './trace-incremental.js';

const SESSION_ID = 'session-trace-window';

function event(id: number, turn: number, type: string, payload: Record<string, unknown> = {}): SessionEventRecord {
  return {
    id,
    sessionId: SESSION_ID,
    turn,
    type,
    source: 'los',
    payload,
    visibility: 'internal',
    createdAt: new Date(1_760_000_000_000 + id * 1_000).toISOString(),
  };
}

function callAndResult(): SessionEventRecord[] {
  return [
    { ...event(1, 1, 'tool.call', { callId: 'call-1', args: { path: 'AGENTS.md' } }), toolName: 'read_file' },
    event(2, 1, 'tool.result', { callId: 'call-1', ok: true, contentPreview: 'ok' }),
  ];
}

function firstCard(projection: ReturnType<typeof foldSessionTrace>['projection']) {
  return projection.turns.flatMap(turn => turn.toolCalls)[0];
}

test('a window folded on a carried seed pairs a call with a later result', () => {
  resetTraceSeedCache();
  const [call, result] = callAndResult();

  const head = foldTraceWindow({ sessionId: SESSION_ID, since: 0, newEvents: [call!], fullEvents: [call!] });
  assert.equal(head.nextSince, 1);
  assert.equal(head.resumed, false);
  assert.equal(firstCard(head.projection)?.status, 'running');

  const tail = foldTraceWindow({ sessionId: SESSION_ID, since: head.nextSince, newEvents: [result!] });
  assert.equal(tail.resumed, true);
  assert.equal(tail.nextSince, 2);

  const card = firstCard(tail.projection);
  assert.equal(card?.callId, 'call-1');
  assert.equal(card?.toolName, 'read_file');
  assert.equal(card?.argsPreview, '{"path":"AGENTS.md"}');
  assert.equal(card?.status, 'completed');
});

test('a cache miss falls back to the full fold and stays correct', () => {
  resetTraceSeedCache();
  const events = callAndResult();

  // No seed was ever remembered for since=1: the result-only window cannot
  // recover the call, so the caller supplies the full log.
  const miss = foldTraceWindow({ sessionId: SESSION_ID, since: 1, newEvents: [events[1]!], fullEvents: events });
  assert.equal(miss.resumed, false);
  assert.equal(miss.nextSince, 2);
  assert.deepEqual(miss.projection, foldSessionTrace(SESSION_ID, events).projection);

  const card = firstCard(miss.projection);
  assert.equal(card?.toolName, 'read_file');
  assert.equal(card?.status, 'completed');
});

test('the cursor returned is exactly the cursor the next seed is stored under', () => {
  resetTraceSeedCache();
  const events = callAndResult();

  const first = foldTraceWindow({ sessionId: SESSION_ID, since: 0, newEvents: events, fullEvents: events });
  assert.equal(first.nextSince, 2);
  assert.ok(readTraceSeed(SESSION_ID, first.nextSince), 'seed must be readable at the returned cursor');
  assert.equal(readTraceSeed(SESSION_ID, first.nextSince)?.lastEventId, first.nextSince);
});

test('replaying the same window twice does not advance or duplicate state', () => {
  resetTraceSeedCache();
  const events = callAndResult();

  const first = foldTraceWindow({ sessionId: SESSION_ID, since: 0, newEvents: events, fullEvents: events });
  const replay = foldTraceWindow({ sessionId: SESSION_ID, since: first.nextSince, newEvents: events });

  assert.equal(replay.nextSince, first.nextSince);
  assert.deepEqual(replay.projection, first.projection);
});

test('foldTraceWindow refuses to guess when neither a seed nor a full log is available', () => {
  resetTraceSeedCache();
  const [, result] = callAndResult();
  assert.throws(
    () => foldTraceWindow({ sessionId: SESSION_ID, since: 7, newEvents: [result!] }),
    /requires fullEvents/,
  );
});
