import test from 'node:test';
import assert from 'node:assert/strict';

import type { SessionEventRecord } from './session-events.js';
import {
  buildGoldenSessionTraceRecords,
  GOLDEN_SESSION_TRACE_PROJECTION,
  GOLDEN_SESSION_TRACE_SESSION_ID,
} from './session-trace-fixtures.js';
import {
  foldSessionTrace,
  projectSessionTrace,
  validateTraceCompleteness,
  type SessionTraceProjection,
} from './session-trace.js';

const SESSION_ID = 'session-trace-incremental';

function event(
  id: number,
  turn: number,
  type: string,
  payload: Record<string, unknown> = {},
): SessionEventRecord {
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

/**
 * Two turns, a tool call in turn 1 whose result lands after the window split,
 * a denied tool in turn 2, and a completion event. Small enough to enumerate
 * every split point.
 */
function traceEvents(): SessionEventRecord[] {
  return [
    event(1, 1, 'turn.started'),
    event(2, 1, 'tool.call', { callId: 'call-a', args: { path: 'AGENTS.md' } }),
    event(3, 1, 'tool.result', { callId: 'call-a', ok: true, contentPreview: 'ok' }),
    event(4, 2, 'model.response', { provider: 'deepseek', durationMs: 12 }),
    event(5, 2, 'tool.call', { callId: 'call-b', args: { command: 'ls' } }),
    event(6, 2, 'tool.denied', { callId: 'call-b', reason: 'policy' }),
    event(7, 2, 'session.completed'),
  ];
}

/** A call in window 1 whose result arrives in window 2 — the case the old endpoint lost. */
function splitToolEvents(): SessionEventRecord[] {
  return [
    { ...event(11, 1, 'tool.call', { callId: 'call-split', args: { path: 'x' } }), toolName: 'read_file' },
    event(12, 1, 'tool.result', { callId: 'call-split', ok: false, errorPreview: 'boom' }),
    event(13, 1, 'turn.started'),
  ];
}

function assertSameProjection(actual: SessionTraceProjection, expected: SessionTraceProjection, label: string): void {
  assert.deepEqual(actual, expected, label);
}

test('golden session trace fixture projects raw events into stable trace turns', () => {
  const events = buildGoldenSessionTraceRecords();
  const projection = projectSessionTrace(GOLDEN_SESSION_TRACE_SESSION_ID, events);

  assert.equal(events.find(event => event.type === 'session.started')?.payload.routeReason, 'explicit_fallback_policy');
  assert.equal(events.find(event => event.type === 'provider.fallback.selected')?.payload.compatibilityEvidenceId, 'compat-golden-xai');
  assert.deepEqual(projection, GOLDEN_SESSION_TRACE_PROJECTION);
  assert.deepEqual(validateTraceCompleteness(events, projection), {
    orphans: [],
    stalledRunning: [],
  });
});

test('incremental fold equals a single fold at every split point', () => {
  const events = traceEvents();
  const full = foldSessionTrace(SESSION_ID, events).projection;

  for (let split = 0; split <= events.length; split += 1) {
    const head = foldSessionTrace(SESSION_ID, events.slice(0, split));
    const tail = foldSessionTrace(SESSION_ID, events.slice(split), head.seed);
    assertSameProjection(tail.projection, full, `split at ${split}`);
    assert.equal(tail.seed.lastEventId, events.at(-1)?.id, `cursor at split ${split}`);
  }
});

test('incremental fold equals a single fold at every two-way split', () => {
  const events = traceEvents();
  const full = foldSessionTrace(SESSION_ID, events).projection;

  for (let first = 0; first <= events.length; first += 1) {
    for (let second = first; second <= events.length; second += 1) {
      const one = foldSessionTrace(SESSION_ID, events.slice(0, first));
      const two = foldSessionTrace(SESSION_ID, events.slice(first, second), one.seed);
      const three = foldSessionTrace(SESSION_ID, events.slice(second), two.seed);
      assertSameProjection(three.projection, full, `splits at ${first}/${second}`);
    }
  }
});

test('replaying an overlapping window is idempotent', () => {
  const events = traceEvents();
  const full = foldSessionTrace(SESSION_ID, events).projection;

  for (let overlap = 1; overlap < events.length; overlap += 1) {
    const head = foldSessionTrace(SESSION_ID, events.slice(0, overlap));
    // The second window starts one event early: replay overlap by one id.
    const tail = foldSessionTrace(SESSION_ID, events.slice(overlap - 1), head.seed);
    assertSameProjection(tail.projection, full, `overlap ${overlap}`);
    assert.equal(tail.seed.lastEventId, events.at(-1)?.id, `cursor after overlap ${overlap}`);
  }
});

test('a tool call split from its result still resolves when the seed is carried', () => {
  const events = splitToolEvents();

  const head = foldSessionTrace(SESSION_ID, events.slice(0, 1));
  const withoutSeed = foldSessionTrace(SESSION_ID, events.slice(1)).projection;
  const withSeed = foldSessionTrace(SESSION_ID, events.slice(1), head.seed).projection;

  const cardWithoutSeed = withoutSeed.turns.flatMap(turn => turn.toolCalls)[0];
  const cardWithSeed = withSeed.turns.flatMap(turn => turn.toolCalls)[0];

  // Negative control: without the seed the result still fabricates a card, but
  // it loses the call's identity and arguments — the pair is silently degraded.
  assert.equal(cardWithoutSeed?.callId, 'call-split');
  assert.equal(cardWithoutSeed?.toolName, '');
  assert.equal(cardWithoutSeed?.argsPreview, '');

  assert.equal(cardWithSeed?.callId, 'call-split');
  assert.equal(cardWithSeed?.toolName, 'read_file');
  assert.equal(cardWithSeed?.argsPreview, '{"path":"x"}');
  assert.equal(cardWithSeed?.status, 'error');
  assert.equal(cardWithSeed?.errorPreview, 'boom');
});

test('session completion still force-closes running calls in incremental mode', () => {
  const events = [
    event(21, 1, 'tool.call', { callId: 'call-open', args: { command: 'sleep 10' } }),
    event(22, 1, 'session.completed'),
  ];

  const head = foldSessionTrace(SESSION_ID, events.slice(0, 1));
  assert.equal(head.projection.turns[0]?.toolCalls[0]?.status, 'running');

  const tail = foldSessionTrace(SESSION_ID, events.slice(1), head.seed);
  assert.equal(tail.projection.turns[0]?.toolCalls[0]?.status, 'error');
});
