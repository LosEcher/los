import assert from 'node:assert/strict';
import test from 'node:test';
import { OperatorAlertDeduper } from './operator-alert-dedupe.js';

test('operator alert dedupe suppresses a replayed event id beyond semantic TTL', () => {
  const deduper = new OperatorAlertDeduper({ semanticTtlMs: 60_000, eventIdTtlMs: 24 * 60 * 60_000 });
  const firstAt = Date.parse('2026-08-11T12:19:32.000Z');

  assert.equal(deduper.shouldSuppress({ eventId: 453842, fallbackKey: 'fleet:node34', now: firstAt }), false);
  assert.equal(deduper.shouldSuppress({
    eventId: 453842,
    fallbackKey: 'fleet:node34',
    now: firstAt + 7 * 60_000,
  }), true);
  assert.equal(deduper.shouldSuppress({
    eventId: 453843,
    fallbackKey: 'fleet:oracle',
    now: firstAt + 7 * 60_000,
  }), false);
});

test('operator alert dedupe retains short semantic fallback for events without ids', () => {
  const deduper = new OperatorAlertDeduper({ semanticTtlMs: 60_000 });
  assert.equal(deduper.shouldSuppress({ fallbackKey: 'fleet:node34', now: 1_000 }), false);
  assert.equal(deduper.shouldSuppress({ fallbackKey: 'fleet:node34', now: 30_000 }), true);
  assert.equal(deduper.shouldSuppress({ fallbackKey: 'fleet:node34', now: 62_000 }), false);
});
