/**
 * Tests for the storm breaker (ADR 0024, step 2).
 *
 * Pins the window/threshold semantics, the mutating-call clearing rule, window
 * eviction, exemption, and reset. Reference: Reasonix `src/repair/storm.ts`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { StormBreaker } from './storm.js';
import type { ToolCall } from '../types.js';

function call(name: string, args: string): ToolCall {
  return { id: `c-${name}-${args.length}`, type: 'function', function: { name, arguments: args } };
}

function breaker(opts: { isMutating?: (n: string) => boolean; isExempt?: (n: string) => boolean; windowSize?: number; threshold?: number } = {}): StormBreaker {
  return new StormBreaker({
    windowSize: opts.windowSize ?? 6,
    threshold: opts.threshold ?? 3,
    isMutating: opts.isMutating ?? (() => false),
    isExempt: opts.isExempt ?? (() => false),
  });
}

test('first two identical calls pass, third is suppressed (threshold=3)', () => {
  const b = breaker();
  assert.equal(b.inspect(call('read', '{}')).suppress, false);
  assert.equal(b.inspect(call('read', '{}')).suppress, false);
  const third = b.inspect(call('read', '{}'));
  assert.equal(third.suppress, true);
  assert.match(third.reason!, /repeated read 3×/);
  assert.equal(b.stormsBroken, 1);
});

test('different arguments are not a storm', () => {
  const b = breaker();
  b.inspect(call('read', '{"p":"a"}'));
  b.inspect(call('read', '{"p":"b"}'));
  assert.equal(b.inspect(call('read', '{"p":"c"}')).suppress, false);
  assert.equal(b.stormsBroken, 0);
});

test('different tool names are not a storm', () => {
  const b = breaker();
  b.inspect(call('read', '{}'));
  b.inspect(call('read', '{}'));
  assert.equal(b.inspect(call('write', '{}')).suppress, false);
});

test('mutating call clears prior read-only entries — a re-read after a write is not suppressed', () => {
  const b = breaker({ isMutating: (n) => n === 'write' });
  // Two reads of the same thing, then a write, then the same read again.
  b.inspect(call('read', '{}'));
  b.inspect(call('read', '{}'));
  // A write mutates state → clears read-only entries.
  assert.equal(b.inspect(call('write', '{}')).suppress, false);
  // The read window was cleared, so this is count=1, not a storm.
  assert.equal(b.inspect(call('read', '{}')).suppress, false);
  assert.equal(b.stormsBroken, 0);
});

test('mutating call itself is still counted — three identical writes still storm', () => {
  const b = breaker({ isMutating: (n) => n === 'write' });
  b.inspect(call('write', '{"x":1}'));
  b.inspect(call('write', '{"x":1}'));
  assert.equal(b.inspect(call('write', '{"x":1}')).suppress, true);
  assert.equal(b.stormsBroken, 1);
});

test('window eviction: a signature that aged out of the window does not storm', () => {
  const b = breaker({ windowSize: 3, threshold: 3 });
  // Two '{x}' calls (count=1 after the second; would storm on a third).
  b.inspect(call('read', '{"x":1}'));
  b.inspect(call('read', '{"x":1}'));
  // Fill the window so both '{x}' entries age out.
  b.inspect(call('read', '{"a":1}')); // [{x},{x},{a}] len 3
  b.inspect(call('read', '{"b":1}')); // shift {x} → [{x},{a},{b}]
  b.inspect(call('read', '{"c":1}')); // shift {x} → [{a},{b},{c}] — both {x} gone
  // '{x}' count is now 0, not a storm. Without eviction this would suppress.
  assert.equal(b.inspect(call('read', '{"x":1}')).suppress, false);
  assert.equal(b.stormsBroken, 0);
});

test('isExempt tools are never suppressed and not counted toward storms', () => {
  const b = breaker({ isExempt: (n) => n === 'search' });
  b.inspect(call('search', '{}'));
  b.inspect(call('search', '{}'));
  assert.equal(b.inspect(call('search', '{}')).suppress, false);
  assert.equal(b.stormsBroken, 0);
});

test('reset clears the window', () => {
  const b = breaker();
  b.inspect(call('read', '{}'));
  b.inspect(call('read', '{}'));
  b.reset();
  // After reset, count starts at 1.
  assert.equal(b.inspect(call('read', '{}')).suppress, false);
  assert.equal(b.inspect(call('read', '{}')).suppress, false);
  assert.equal(b.inspect(call('read', '{}')).suppress, true);
});

test('suppressed calls are not recorded into the window (no double-count drift)', () => {
  const b = breaker();
  b.inspect(call('read', '{}'));
  b.inspect(call('read', '{}'));
  // 3rd suppressed — should NOT add a 3rd entry (otherwise count keeps climbing).
  b.inspect(call('read', '{}'));
  // A different call then the same again: only 2 prior '{}' entries exist.
  b.inspect(call('other', '{}'));
  assert.equal(b.inspect(call('read', '{}')).suppress, true); // count=2 → suppress
  assert.equal(b.stormsBroken, 2);
});
