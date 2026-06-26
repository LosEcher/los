/**
 * Integration tests for the repair orchestration layer (ADR 0024).
 *
 * `healing.test.ts` and `storm.test.ts` unit-test the individual stages. These
 * tests exercise `healBeforeSend` and `repairToolCalls` end-to-end through the
 * orchestration module — the layer `loop.ts` actually calls — including the
 * storm-suppression path that the unit tests only cover at the `inspect` level.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { healBeforeSend, repairToolCalls, StormBreaker } from './repair-pipeline.js';
import type { Message, ToolCall } from './types.js';
import type { ModelProfile } from '../model-profiles.js';

const ctx = (overrides: Partial<{ stormBreaker: StormBreaker }> = {}) => ({
  providerName: 'test-provider',
  profile: { supportsReasoning: false } as unknown as ModelProfile,
  ...overrides,
});

function call(name: string, args: string): ToolCall {
  return { id: `c-${name}-${args.length}-${Math.random().toString(36).slice(2, 6)}`, type: 'function', function: { name, arguments: args } };
}
function user(t: string): Message { return { role: 'user', content: t }; }
function assistant(calls: ToolCall[]): Message {
  return { role: 'assistant', content: '', tool_calls: calls };
}
function toolResult(id: string): Message { return { role: 'tool', tool_call_id: id, content: 'ok' }; }

// ── healBeforeSend end-to-end (in-place mutation) ───────────────────

test('healBeforeSend mutates the messages array in place when repair is needed', () => {
  const messages: Message[] = [user('hi'), assistant([call('foo', '{}')])]; // unpaired
  const before = messages; // reference
  const res = healBeforeSend(messages, ctx());
  assert.equal(res.changed, true);
  assert.equal(messages, before, 'same array reference (in-place)');
  assert.equal(messages.length, 1, 'unpaired assistant dropped in place');
  assert.equal(messages[0].role, 'user');
});

test('healBeforeSend leaves a clean history untouched (no rebuild)', () => {
  const a = call('foo', '{}');
  const messages: Message[] = [user('hi'), assistant([a]), toolResult(a.id)];
  const res = healBeforeSend(messages, ctx());
  assert.equal(res.changed, false);
  assert.equal(messages.length, 3);
});

// ── repairToolCalls end-to-end (storm suppression) ───────────────────

test('repairToolCalls: no storm breaker → pass-through unchanged', () => {
  const calls = [call('read', '{}'), call('write', '{}')];
  const res = repairToolCalls(calls, ctx());
  assert.equal(res.calls.length, 2);
  assert.equal(res.suppressedCount, 0);
  assert.equal(res.calls, calls, 'returns same array when nothing suppressed');
});

test('repairToolCalls: suppresses the 3rd identical call, keeps the rest', () => {
  const breaker = new StormBreaker({ threshold: 3, windowSize: 6 });
  const c1 = call('read', '{"p":1}');
  const c2 = call('read', '{"p":1}');
  const c3 = call('read', '{"p":1}'); // 3rd → suppressed
  const c4 = call('write', '{}');
  const res = repairToolCalls([c1, c2, c3, c4], ctx({ stormBreaker: breaker }));
  assert.equal(res.suppressedCount, 1);
  assert.equal(res.calls.length, 3);
  assert.equal(res.calls[0], c1);
  assert.equal(res.calls[1], c2);
  assert.equal(res.calls[2], c4, 'non-storming call preserved');
  assert.equal(res.notes.length, 1);
  assert.match(res.notes[0], /storm:/);
});

test('repairToolCalls: all-suppressed turn returns empty calls array (loop continues, does not exit)', () => {
  // Cross-iteration storm: a single repeated call that has already appeared
  // twice in the breaker's window. This turn emits it once more → suppressed.
  // repaired.calls is empty; loop.ts keeps res.toolCalls.length>0 so the run
  // continues rather than exiting. This pins that contract.
  const breaker = new StormBreaker({ threshold: 3, windowSize: 6 });
  breaker.inspect(call('read', '{"x":1}'));
  breaker.inspect(call('read', '{"x":1}'));
  // This turn:
  const res = repairToolCalls([call('read', '{"x":1}')], ctx({ stormBreaker: breaker }));
  assert.equal(res.suppressedCount, 1);
  assert.equal(res.calls.length, 0, 'all-suppressed → empty (loop will re-prompt, bounded by maxLoops)');
});
