import test from 'node:test';
import assert from 'node:assert/strict';

import { maskToolResults } from './masking.js';
import { compressOrTrimMessages } from './compression.js';
import { estimateMessageTokens } from './token-utils.js';
import type { Message } from '../providers/index.js';

function toolMessage(content: string, callId = 'c1'): Message {
  return { role: 'tool', content, tool_call_id: callId };
}

// ── Mask card extraction (via the public maskToolResults path) ──

test('maskToolResults keeps short tool results and empty content unchanged', () => {
  const messages = [toolMessage(''), toolMessage('ok'), toolMessage('a'.repeat(200))];
  const masked = maskToolResults(messages);
  assert.equal(masked[0]!.content, '');
  assert.equal(masked[1]!.content, 'ok');
  assert.equal(masked[2]!.content, 'a'.repeat(200));
});

test('maskToolResults summarizes JSON tool outputs by shape', () => {
  const big: Record<string, unknown> = {};
  for (let i = 0; i < 40; i++) big[`key-${i}`] = `value-${i}-`.repeat(10);
  const raw = JSON.stringify(big);
  assert.ok(raw.length > 240);
  const [masked] = maskToolResults([toolMessage(raw)]);
  assert.ok(masked!.content.startsWith('[mask:json] object keys:'), masked!.content);
  assert.ok(masked!.content.includes('key-0'));
  assert.ok(masked!.content.includes('(+28 more)'));
  assert.ok(masked!.content.length <= 240);
});

test('maskToolResults summarizes JSON arrays with first element preview', () => {
  const bigArray = Array.from({ length: 40 }, (_, i) => ({ id: i, name: `item-${i}-${'x'.repeat(8)}` }));
  const [masked] = maskToolResults([toolMessage(JSON.stringify(bigArray))]);
  assert.ok(masked!.content.startsWith('[mask:json] array[40]'), masked!.content);
  assert.ok(masked!.content.includes('first:'));
});

test('maskToolResults summarizes multi-line text with head, size, and error signal', () => {
  const lines = ['start', 'command failed: exit code 1', ...Array.from({ length: 498 }, (_, i) => `line ${i} content`)];
  const [masked] = maskToolResults([toolMessage(lines.join('\n'))]);
  assert.ok(masked!.content.startsWith('[mask:500 lines,'), masked!.content);
  assert.ok(masked!.content.includes('head: start'));
  assert.ok(masked!.content.includes('failed'), 'error signal surfaced');
  assert.ok(masked!.content.length <= 240);
});

test('maskToolResults truncates long single lines with ellipsis', () => {
  const [masked] = maskToolResults([toolMessage('x'.repeat(10_000))]);
  assert.ok(masked!.content.length <= 240);
  assert.ok(masked!.content.endsWith('…'));
});

test('maskToolResults only replaces tool messages', () => {
  const messages: Message[] = [
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: 'running' },
    toolMessage('huge output\n'.repeat(1000)),
  ];
  const masked = maskToolResults(messages);
  assert.equal(masked[0], messages[0]);
  assert.equal(masked[1], messages[1]);
  assert.notEqual(masked[2], messages[2]);
  assert.ok(masked[2]!.content.startsWith('[mask:'), masked[2]!.content.slice(0, 60));
});

// ── Cascade tiers ────────────────────────────────────────

function cascadeMessages(): Message[] {
  return [
    { role: 'system', content: 'You are a helpful agent.' },
    { role: 'user', content: 'old task' },
    { role: 'assistant', content: 'I will look at it.' },
    toolMessage('x\n'.repeat(1500), 'tool-1'),
    { role: 'user', content: 'new task' },
    { role: 'assistant', content: 'done' },
    toolMessage('y'.repeat(80), 'tool-2'),
  ];
}

test('warning tier masks tool results and keeps turn structure', () => {
  const messages = cascadeMessages();
  // ratio ≈ 792/950 = 0.83 → within (0.80, 0.88] → Layer 2
  const compressed = compressOrTrimMessages(messages, 950, { enabled: true });
  assert.equal(compressed.length, messages.length, 'structure preserved at warning tier');
  assert.ok(!compressed.some(m => m.content.includes('[Compressed earlier context]')), 'no summary at warning tier');
  const tool1 = compressed.find(m => m.tool_call_id === 'tool-1');
  assert.ok(tool1!.content.startsWith('[mask:'), 'old tool result masked');
  const tool2 = compressed.find(m => m.tool_call_id === 'tool-2');
  assert.equal(tool2!.content, 'y'.repeat(80), 'recent tool result untouched');
  const assistant = compressed.find(m => m.role === 'assistant' && m.content === 'I will look at it.');
  assert.ok(assistant, 'assistant text survives masking');
});

test('aggressive tier collapses masked turns into one summary', () => {
  const messages = cascadeMessages();
  // ratio ≈ 792/880 = 0.90 → > 0.88 → Layer 3
  const compressed = compressOrTrimMessages(messages, 880, { enabled: true });
  assert.ok(compressed.length < messages.length, 'summary collapses messages');
  const summary = compressed.find(m => m.content.includes('[Compressed earlier context]'));
  assert.ok(summary, 'summary message present');
  assert.ok(!compressed.some(m => m.content === 'x\n'.repeat(1500)), 'raw tool output dropped');
});

test('emergency tier hard-trims to budget', () => {
  const messages = cascadeMessages();
  // ratio ≈ 792/800 = 0.99 → > 0.95 → hard trim
  const compressed = compressOrTrimMessages(messages, 800, { enabled: true });
  assert.ok(compressed.length < messages.length, 'hard trim drops messages');
  assert.ok(compressed.some(m => m.role === 'system'), 'system preserved');
  assert.equal(compressed[compressed.length - 1]!.content, 'y'.repeat(80), 'latest message preserved');
});

test('masking.enabled=false restores single-step summary at warning tier', () => {
  const messages = cascadeMessages();
  const compressed = compressOrTrimMessages(messages, 950, { enabled: true, masking: { enabled: false } });
  assert.ok(compressed.length < messages.length, 'legacy behavior collapses at warning tier');
  assert.ok(compressed.some(m => m.content.includes('[Compressed earlier context]')));
});

test('cache-aware tier keeps head untouched under healthy cache', () => {
  const messages = cascadeMessages();
  const compressed = compressOrTrimMessages(messages, 950, { enabled: true }, 0.8);
  // cache alive → head-preserving path: no structural masking, no summary,
  // and within-budget tail-only eviction has nothing to evict
  assert.ok(!compressed.some(m => m.content.includes('[Compressed earlier context]')));
  assert.ok(!compressed.some(m => m.content.startsWith('[mask:')), 'no mask cards under healthy cache');
  assert.ok(compressed.some(m => m.content === 'x\n'.repeat(1500)), 'head tool result untouched');
  assert.equal(compressed.length, messages.length, 'structure unchanged within budget');
});

test('masking cascade deepens across repeated compaction calls', () => {
  let messages = cascadeMessages();
  // First pass: warning tier masks the old turn
  messages = compressOrTrimMessages(messages, 950, { enabled: true });
  assert.ok(messages.some(m => m.content.startsWith('[mask:')));
  // Simulate continued work: more large tool output arrives after the mask.
  const grown: Message[] = [
    ...messages,
    { role: 'assistant', content: 'more work', tool_calls: [] },
    toolMessage('big output\n'.repeat(8000), 'tool-3'),
    { role: 'user', content: 'final' },
  ];
  // Second pass with a budget in the aggressive band: ratio ≈ 0.92 ∈ (0.88, 0.95]
  const total = grown.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  const budget = Math.max(1, Math.floor(total / 0.92));
  const second = compressOrTrimMessages(grown, budget, { enabled: true });
  assert.ok(second.length < grown.length, 'deeper tier collapses further');
  assert.ok(second.some(m => m.content.includes('[Compressed earlier context]')), 'summary at aggressive tier');
  assert.ok(!second.some(m => m.content.includes('big output')), 'raw output dropped');
});
