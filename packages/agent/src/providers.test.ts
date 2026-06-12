import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOpenAICompatUrl, mergeToolCallDeltas } from './providers/index.js';
import type { ToolCall } from './providers/types.js';

test('OpenAI-compatible URLs normalize missing v1 segments', () => {
  assert.equal(
    buildOpenAICompatUrl('https://api.deepseek.com', '/chat/completions'),
    'https://api.deepseek.com/v1/chat/completions',
  );
  assert.equal(
    buildOpenAICompatUrl('https://api.deepseek.com/', '/models'),
    'https://api.deepseek.com/v1/models',
  );
});

test('OpenAI-compatible URLs do not duplicate existing v1 segments', () => {
  assert.equal(
    buildOpenAICompatUrl('https://www.packyapi.com/v1', '/chat/completions'),
    'https://www.packyapi.com/v1/chat/completions',
  );
  assert.equal(
    buildOpenAICompatUrl('http://127.0.0.1:11434/v1/', 'models'),
    'http://127.0.0.1:11434/v1/models',
  );
});

// ── mergeToolCallDeltas — Chat Completions streaming delta aggregation ──

test('mergeToolCallDeltas aggregates standard OpenAI deltas with index', () => {
  const map = new Map<number, ToolCall>();

  // First delta — new tool call at index 0
  mergeToolCallDeltas(map, [
    { index: 0, id: 'call_abc', function: { name: 'read_file', arguments: '{"path":' } },
  ]);
  assert.equal(map.size, 1);
  assert.equal(map.get(0)!.id, 'call_abc');
  assert.equal(map.get(0)!.function.name, 'read_file');

  // Second delta — continuation at index 0
  mergeToolCallDeltas(map, [
    { index: 0, function: { arguments: '"/etc/hosts"}' } },
  ]);
  assert.equal(map.size, 1);
  assert.equal(map.get(0)!.function.arguments, '{"path":"/etc/hosts"}');
  assert.deepEqual(JSON.parse(map.get(0)!.function.arguments), { path: '/etc/hosts' });
});

test('mergeToolCallDeltas handles PackyCode-style deltas without index', () => {
  const map = new Map<number, ToolCall>();

  // First delta includes index
  mergeToolCallDeltas(map, [
    { index: 0, id: 'call_V6MjbGRirkhIfWB4xkYszko7', function: { name: 'directory_tree', arguments: '' } },
  ]);
  assert.equal(map.size, 1);
  assert.equal(map.get(0)!.function.name, 'directory_tree');

  // Second delta: NO index, NO id — PackyCode-style follow-up delta
  mergeToolCallDeltas(map, [
    { function: { arguments: '{"maxDepth":2,"path":"."}' } },
  ]);
  assert.equal(map.size, 1, 'should not create a phantom tool call');
  assert.equal(map.get(0)!.function.arguments, '{"maxDepth":2,"path":"."}');
  assert.deepEqual(JSON.parse(map.get(0)!.function.arguments), { maxDepth: 2, path: '.' });
});

test('mergeToolCallDeltas matches continuation delta by id when index is missing', () => {
  const map = new Map<number, ToolCall>();

  // Two parallel tool calls
  mergeToolCallDeltas(map, [
    { index: 0, id: 'call_A', function: { name: 'tool_a', arguments: '{"x":' } },
    { index: 1, id: 'call_B', function: { name: 'tool_b', arguments: '{"y":' } },
  ]);
  assert.equal(map.size, 2);

  // Continuation for call_B by id (no index)
  mergeToolCallDeltas(map, [
    { id: 'call_B', function: { arguments: '1}' } },
  ]);
  assert.equal(map.size, 2, 'should not create a third entry');
  assert.equal(map.get(1)!.function.arguments, '{"y":1}');

  // Continuation for call_A by id (no index)
  mergeToolCallDeltas(map, [
    { id: 'call_A', function: { arguments: '1}' } },
  ]);
  assert.equal(map.get(0)!.function.arguments, '{"x":1}');
});

test('mergeToolCallDeltas handles PackyCode index-switch (name at 0, args at 1)', () => {
  // PackyCode sends the name+id delta at index=0, then all argument
  // fragments at index=1 (without id). The result must be a single tool call.
  const map = new Map<number, ToolCall>();

  mergeToolCallDeltas(map, [
    { index: 0, id: 'call_ABC', function: { name: 'directory_tree', arguments: '' } },
  ]);
  assert.equal(map.size, 1);

  // Arguments arrive at index=1 — PackyCode quirk
  mergeToolCallDeltas(map, [
    { index: 1, function: { arguments: '{"' } },
  ]);
  assert.equal(map.size, 1, 'should not create phantom at index 1');
  assert.equal(map.get(0)!.function.arguments, '{"');

  mergeToolCallDeltas(map, [
    { index: 1, function: { arguments: 'maxDepth":' } },
  ]);
  mergeToolCallDeltas(map, [
    { index: 1, function: { arguments: '2,"path":"."}' } },
  ]);

  assert.equal(map.size, 1, 'all fragments merged into one call');
  assert.equal(map.get(0)!.function.arguments, '{"maxDepth":2,"path":"."}');
  assert.deepEqual(JSON.parse(map.get(0)!.function.arguments), { maxDepth: 2, path: '.' });
});

test('mergeToolCallDeltas parallel tool calls with mixed index presence', () => {
  const map = new Map<number, ToolCall>();

  // call_A: index present throughout (standard behavior)
  mergeToolCallDeltas(map, [
    { index: 0, id: 'call_read', function: { name: 'read_file', arguments: '{"path":"/a"}' } },
  ]);

  // call_B: first delta has index, follow-ups don't (PackyCode behavior)
  mergeToolCallDeltas(map, [
    { index: 1, id: 'call_list', function: { name: 'list_directory', arguments: '{"path":' } },
  ]);
  mergeToolCallDeltas(map, [
    { function: { arguments: '"."}' } },  // no index, no id → last entry
  ]);

  assert.equal(map.size, 2);
  assert.equal(map.get(0)!.function.name, 'read_file');
  assert.equal(map.get(0)!.function.arguments, '{"path":"/a"}');
  assert.equal(map.get(1)!.function.name, 'list_directory');
  // The no-index/no-id delta should go to the last tool call (call_list at index 1),
  // NOT create a new phantom call_2 entry
  assert.ok(!map.has(2), 'should not create phantom tool call at index 2');
  assert.deepEqual(JSON.parse(map.get(1)!.function.arguments), { path: '.' });
});
