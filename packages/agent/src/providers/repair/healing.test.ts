/**
 * Regression tests for pre-send tool-call pairing repair (ADR 0024).
 *
 * Covers `fixToolCallPairing` — the first stage of the `healBeforeSend`
 * orchestration. The agent loop always appends assistant+tool messages
 * together, so within a run the history is paired. The unpaired case arises
 * when a session is resumed via `initialMessages` after an interrupted tool
 * turn. These tests pin the repair so a resumed session does not 400.
 *
 * Reference: Reasonix `src/loop/healing.ts` `fixToolCallPairing`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fixToolCallPairing } from './healing.js';
import { getRepairCounters } from '../repair-telemetry.js';
import type { Message } from '../types.js';

const PROVIDER = 'test-provider';

function assistant(toolCalls: Array<{ id: string; name: string; args?: string }>): Message {
  return {
    role: 'assistant',
    content: '',
    tool_calls: toolCalls.map(tc => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.args ?? '{}' },
    })),
  };
}

function toolResult(callId: string, content = 'ok'): Message {
  return { role: 'tool', tool_call_id: callId, content };
}

function user(text: string): Message {
  return { role: 'user', content: text };
}

// ── Paired history is left untouched ───────────────────

test('fully paired assistant + tool results: unchanged, same array reference', () => {
  const input: Message[] = [
    user('do thing'),
    assistant([{ id: 'a', name: 'foo' }, { id: 'b', name: 'bar' }]),
    toolResult('a'),
    toolResult('b'),
  ];
  const res = fixToolCallPairing(input, PROVIDER);
  assert.equal(res.changed, false);
  assert.equal(res.droppedUnpairedAssistant, 0);
  assert.equal(res.droppedOrphanTool, 0);
  assert.equal(res.messages, input);
});

test('plain text turn with no tool calls: unchanged', () => {
  const input: Message[] = [user('hi'), { role: 'assistant', content: 'hello' }];
  const res = fixToolCallPairing(input, PROVIDER);
  assert.equal(res.changed, false);
  assert.equal(res.messages.length, 2);
});

// ── Unpaired assistant is dropped along with its orphan tool messages ──

test('assistant with one unpaired tool_call: assistant + orphan tool dropped', () => {
  // 'b' has no tool result → whole assistant dropped; 'a' tool result is now orphan.
  const input: Message[] = [
    user('do thing'),
    assistant([{ id: 'a', name: 'foo' }, { id: 'b', name: 'bar' }]),
    toolResult('a'),
  ];
  const res = fixToolCallPairing(input, PROVIDER);
  assert.equal(res.changed, true);
  assert.equal(res.droppedUnpairedAssistant, 1);
  assert.equal(res.droppedOrphanTool, 1);
  assert.deepEqual(res.messages.map(m => m.role), ['user']);
});

test('orphan tool message with no parent assistant: dropped', () => {
  const input: Message[] = [user('hi'), toolResult('ghost')];
  const res = fixToolCallPairing(input, PROVIDER);
  assert.equal(res.changed, true);
  assert.equal(res.droppedOrphanTool, 1);
  assert.equal(res.messages.length, 1);
  assert.equal(res.messages[0].role, 'user');
});

test('multiple turns: only the unpaired turn is dropped, earlier paired turn kept', () => {
  const input: Message[] = [
    user('first'),
    assistant([{ id: 'a', name: 'foo' }]),
    toolResult('a'),
    user('second'),
    assistant([{ id: 'b', name: 'bar' }]), // 'b' has no result
  ];
  const res = fixToolCallPairing(input, PROVIDER);
  assert.equal(res.droppedUnpairedAssistant, 1);
  assert.equal(res.droppedOrphanTool, 0);
  assert.equal(res.messages.length, 4);
  assert.deepEqual(res.messages.map(m => m.role), ['user', 'assistant', 'tool', 'user']);
});

test('assistant whose tool result comes later in the array is still paired', () => {
  // Order tolerance: tool result may follow other messages.
  const input: Message[] = [
    user('do thing'),
    assistant([{ id: 'a', name: 'foo' }]),
    user('reminder'),
    toolResult('a'),
  ];
  const res = fixToolCallPairing(input, PROVIDER);
  assert.equal(res.changed, false);
  assert.equal(res.messages.length, 4);
});

// ── Telemetry fires exactly once per changed history ───────────────────

test('changed history increments the unpaired_tool_call_dropped counter once', () => {
  const before = getRepairCounters()[`${PROVIDER}:unpaired_tool_call_dropped`] ?? 0;
  const input: Message[] = [user('hi'), assistant([{ id: 'x', name: 'foo' }])];
  const res = fixToolCallPairing(input, PROVIDER);
  const after = getRepairCounters()[`${PROVIDER}:unpaired_tool_call_dropped`] ?? 0;
  assert.equal(res.changed, true);
  assert.equal(after, before + 1);
});

test('unchanged history does not increment the counter', () => {
  const before = getRepairCounters()[`${PROVIDER}:unpaired_tool_call_dropped`] ?? 0;
  const input: Message[] = [
    user('hi'),
    assistant([{ id: 'y', name: 'foo' }]),
    toolResult('y'),
  ];
  fixToolCallPairing(input, PROVIDER);
  const after = getRepairCounters()[`${PROVIDER}:unpaired_tool_call_dropped`] ?? 0;
  assert.equal(after, before);
});
