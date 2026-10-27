/**
 * Durable resume cursor for external operator-event-stream consumers
 * (audit migration item D11).
 *
 * The bug being fixed: the stream endpoint defaults to `since=0`, so a consumer
 * without a cursor replays the whole operator history on every reconnect.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideOperatorEventStreamResume,
  loadOperatorEventStreamCursor,
  saveOperatorEventStreamCursor,
} from './operator-event-stream-cursor.js';

const MAX = 15 * 60_000;
const NOW = 1_800_000_000_000;
const CONSUMER = `test-consumer-${Date.now()}`;

test('no stored cursor tails the stream instead of replaying all history', () => {
  const decision = decideOperatorEventStreamResume({
    lastEventId: 0,
    updatedAtMs: null,
    nowMs: NOW,
    maxCatchupMs: MAX,
  });
  assert.equal(decision.mode, 'tail');
  assert.equal(decision.query, 'tail=1');
});

test('a fresh cursor resumes exactly where the consumer stopped', () => {
  const decision = decideOperatorEventStreamResume({
    lastEventId: 4211,
    updatedAtMs: NOW - 30_000,
    nowMs: NOW,
    maxCatchupMs: MAX,
  });
  assert.equal(decision.mode, 'since');
  assert.equal(decision.query, 'since=4211');
});

test('a cursor exactly at the catch-up boundary still resumes (bounded, inclusive)', () => {
  const decision = decideOperatorEventStreamResume({
    lastEventId: 99,
    updatedAtMs: NOW - MAX,
    nowMs: NOW,
    maxCatchupMs: MAX,
  });
  assert.equal(decision.query, 'since=99');
});

test('a stale cursor skips the backlog rather than replaying it', () => {
  const decision = decideOperatorEventStreamResume({
    lastEventId: 99,
    updatedAtMs: NOW - MAX - 1,
    nowMs: NOW,
    maxCatchupMs: MAX,
  });
  assert.equal(decision.mode, 'tail');
  assert.equal(decision.query, 'tail=1');
});

test('a cursor without a usable timestamp is treated as unknown, not fresh', () => {
  const decision = decideOperatorEventStreamResume({
    lastEventId: 7,
    updatedAtMs: null,
    nowMs: NOW,
    maxCatchupMs: MAX,
  });
  assert.equal(decision.query, 'tail=1');
});

test('cursors are isolated per consumer', async () => {
  await saveOperatorEventStreamCursor(`${CONSUMER}-a`, 10);
  await saveOperatorEventStreamCursor(`${CONSUMER}-b`, 20);
  const a = await loadOperatorEventStreamCursor(`${CONSUMER}-a`);
  const b = await loadOperatorEventStreamCursor(`${CONSUMER}-b`);
  assert.equal(a!.lastEventId, 10);
  assert.equal(b!.lastEventId, 20);
});

test('the durable cursor round-trips and never moves backwards', async () => {
  const consumer = `${CONSUMER}-mono`;
  assert.equal(await loadOperatorEventStreamCursor(consumer), null);

  await saveOperatorEventStreamCursor(consumer, 1000);
  const loaded = await loadOperatorEventStreamCursor(consumer);
  assert.equal(loaded!.lastEventId, 1000);
  assert.equal(typeof loaded!.updatedAtMs, 'number');

  // A late flush from an older stream must not rewind the cursor.
  await saveOperatorEventStreamCursor(consumer, 400);
  assert.equal((await loadOperatorEventStreamCursor(consumer))!.lastEventId, 1000);

  await saveOperatorEventStreamCursor(consumer, 1001);
  assert.equal((await loadOperatorEventStreamCursor(consumer))!.lastEventId, 1001);
});

test('non-positive and non-finite cursor writes are ignored', async () => {
  const consumer = `${CONSUMER}-invalid`;
  await saveOperatorEventStreamCursor(consumer, 2000);
  await saveOperatorEventStreamCursor(consumer, 0);
  await saveOperatorEventStreamCursor(consumer, Number.NaN);
  assert.equal((await loadOperatorEventStreamCursor(consumer))!.lastEventId, 2000);
});
