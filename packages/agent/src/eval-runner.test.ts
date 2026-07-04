/**
 * @los/agent/eval-runner — unit tests for eval harness components.
 *
 * Tests the MockProvider, eval metric collection, and diff helpers
 * without hitting a real provider or database.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMockProvider,
  diffEvalMetrics,
  formatEvalReport,
  type MockTurn,
  type EvalMetrics,
} from './eval-runner.js';
import type { Message, ToolCall } from './providers/index.js';

// ── MockProvider ───────────────────────────────────────────

test('mock provider returns pre-scripted text responses', async () => {
  const script: MockTurn[] = [
    { text: 'I will read the file first.' },
    { text: 'The file says hello.' },
  ];
  const provider = createMockProvider({ script });

  const res1 = await provider.chat([{ role: 'user', content: 'read file' }]);
  assert.ok(res1.text.includes('read the file'));
  assert.equal(res1.toolCalls.length, 0);
  assert.equal(res1.finishReason, 'stop');
  assert.ok(res1.usage.promptTokens > 0, 'prompt tokens computed from messages');
  assert.ok(res1.usage.completionTokens > 0, 'completion tokens computed from text');

  const res2 = await provider.chat([{ role: 'user', content: 'what is in it' }]);
  assert.ok(res2.text.includes('hello'));
  assert.equal(res2.finishReason, 'stop');
});

test('mock provider returns tool calls when scripted', async () => {
  const script: MockTurn[] = [
    {
      text: 'Let me check.',
      toolCalls: [{ name: 'read_file', args: { path: '/x.ts' } }],
    },
  ];
  const provider = createMockProvider({ script });

  const res = await provider.chat([{ role: 'user', content: 'check x' }]);
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0]!.function.name, 'read_file');
  assert.equal(JSON.parse(res.toolCalls[0]!.function.arguments).path, '/x.ts');
  assert.equal(res.finishReason, 'tool_calls');
});

test('mock provider includes reasoning when scripted', async () => {
  const script: MockTurn[] = [
    {
      text: 'I need to look at this.',
      reasoning: 'The user wants to understand the code structure. I should start by reading the entry point.',
    },
  ];
  const provider = createMockProvider({ script });

  const res = await provider.chat([{ role: 'user', content: 'explain code' }]);
  assert.ok(res.reasoningContent);
  assert.ok(res.reasoningContent!.length > 20);
  // Reasoning should add to completion tokens
  assert.ok(res.usage.completionTokens > 0);
});

test('mock provider repeats last turn beyond script length', async () => {
  const script: MockTurn[] = [
    { text: 'turn 1' },
    { text: 'turn 2' },
  ];
  const provider = createMockProvider({ script });

  await provider.chat([]); // turn 1
  await provider.chat([]); // turn 2
  const res3 = await provider.chat([]); // repeats last
  assert.ok(res3.text === 'turn 2');
});

test('mock provider usage can be overridden per-turn', async () => {
  const script: MockTurn[] = [
    { text: 'done', usage: { promptTokens: 100, completionTokens: 20 } },
  ];
  const provider = createMockProvider({ script });

  const res = await provider.chat([{ role: 'user', content: 'test' }]);
  assert.equal(res.usage.promptTokens, 100);
  assert.equal(res.usage.completionTokens, 20);
  assert.equal(res.usage.totalTokens, 120);
});

test('mock provider reports the configured model', async () => {
  const provider = createMockProvider({
    script: [{ text: 'ok' }],
    model: 'test-model-v1',
  });

  const res = await provider.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(res.model, 'test-model-v1');
});

// ── ToolCall shapes ────────────────────────────────────────

test('mock provider tool calls are valid ToolCall shapes', async () => {
  const script: MockTurn[] = [
    {
      text: 'patching',
      toolCalls: [
        { name: 'preview_patch', args: { hunks: [{ old: 'a', new: 'b' }] } },
        { name: 'run_shell', args: { command: 'pnpm check' } },
      ],
    },
  ];
  const provider = createMockProvider({ script });
  const res = await provider.chat([{ role: 'user', content: 'patch it' }]);

  assert.equal(res.toolCalls.length, 2);
  for (const tc of res.toolCalls) {
    assert.equal(tc.type, 'function');
    assert.ok(tc.id.startsWith('mock-call-'));
    assert.ok(typeof tc.function.name === 'string');
    assert.ok(typeof tc.function.arguments === 'string');
    JSON.parse(tc.function.arguments); // valid JSON
  }
});

// ── Metrics helpers ────────────────────────────────────────

function makeMetrics(overrides: Partial<EvalMetrics> & { scenarioId: string }): EvalMetrics {
  return {
    scenarioId: overrides.scenarioId,
    description: overrides.description ?? 'test scenario',
    passed: overrides.passed ?? true,
    failures: overrides.failures ?? [],
    turns: overrides.turns ?? 3,
    totalPromptTokens: overrides.totalPromptTokens ?? 500,
    totalCompletionTokens: overrides.totalCompletionTokens ?? 200,
    estimatedMessageTokens: overrides.estimatedMessageTokens ?? 700,
    estimatedTotalTokens: overrides.estimatedTotalTokens ?? 700,
    completed: overrides.completed ?? true,
    durationMs: overrides.durationMs ?? 150,
  };
}

test('diffEvalMetrics computes token and turn deltas', () => {
  const before: EvalMetrics[] = [
    makeMetrics({ scenarioId: 's1', estimatedTotalTokens: 1000, estimatedMessageTokens: 800, turns: 5 }),
    makeMetrics({ scenarioId: 's2', estimatedTotalTokens: 2000, estimatedMessageTokens: 1500, turns: 8 }),
  ];
  // Simulate a 30% improvement on s1 and 10% on s2
  const after: EvalMetrics[] = [
    makeMetrics({ scenarioId: 's1', estimatedTotalTokens: 700, estimatedMessageTokens: 480, turns: 4 }),
    makeMetrics({ scenarioId: 's2', estimatedTotalTokens: 1800, estimatedMessageTokens: 1350, turns: 7 }),
  ];

  const diffs = diffEvalMetrics(before, after);

  assert.equal(diffs.length, 2);
  assert.deepEqual(diffs.map(d => d.scenarioId).sort(), ['s1', 's2']);

  const s1 = diffs.find(d => d.scenarioId === 's1')!;
  assert.equal(s1.tokenDiff, -300);
  assert.ok(s1.tokenDiffPct < -29 && s1.tokenDiffPct > -31, `expected ~-30%, got ${s1.tokenDiffPct}`);
  assert.equal(s1.turnDiff, -1);
  assert.ok(s1.msgTokenDiffPct < -39 && s1.msgTokenDiffPct > -41, `expected ~-40%, got ${s1.msgTokenDiffPct}`);

  const s2 = diffs.find(d => d.scenarioId === 's2')!;
  assert.equal(s2.tokenDiff, -200);
  assert.ok(s2.tokenDiffPct < -9 && s2.tokenDiffPct > -11);
});

test('diffEvalMetrics returns empty for no overlap', () => {
  const before: EvalMetrics[] = [makeMetrics({ scenarioId: 's1' })];
  const after: EvalMetrics[] = [makeMetrics({ scenarioId: 's3' })];

  const diffs = diffEvalMetrics(before, after);
  assert.equal(diffs.length, 0);
});

test('formatEvalReport produces readable summary', () => {
  const metrics: EvalMetrics[] = [
    makeMetrics({ scenarioId: 's1', turns: 2, estimatedTotalTokens: 400, durationMs: 100 }),
    makeMetrics({ scenarioId: 's2', passed: false, failures: ['missing tool: read_file'], turns: 4, estimatedTotalTokens: 800, durationMs: 200 }),
  ];

  const report = formatEvalReport(metrics, 'baseline');
  assert.ok(report.includes('Eval Report: baseline'));
  assert.ok(report.includes('Passed: 1/2'));
  assert.ok(report.includes('✅ s1'));
  assert.ok(report.includes('❌ s2'));
  assert.ok(report.includes('missing tool'));
  assert.ok(report.includes('Total: 1200 tokens'));
});

test('formatEvalReport handles empty list', () => {
  const report = formatEvalReport([], 'empty');
  assert.ok(report.includes('Eval Report: empty'));
  assert.ok(report.includes('Passed: 0/0'));
});

// ── Multi-turn scenario ────────────────────────────────────

test('multi-turn script completes when no tool calls remain', async () => {
  const script: MockTurn[] = [
    {
      text: 'Reading the file.',
      toolCalls: [{ name: 'read_file', args: { path: 'readme.md' } }],
    },
    {
      text: 'File says: # los project. I will now summarize.',
    },
  ];
  const provider = createMockProvider({ script });

  // Turn 1: tool call
  const t1 = await provider.chat([{ role: 'user', content: 'summarize' }]);
  assert.equal(t1.toolCalls.length, 1);
  assert.equal(t1.finishReason, 'tool_calls');

  // Turn 2: tool result → final text
  const t2 = await provider.chat([
    { role: 'user', content: 'summarize' },
    { role: 'assistant', content: t1.text, tool_calls: t1.toolCalls },
    { role: 'tool', content: '# los project', tool_call_id: t1.toolCalls[0]!.id },
  ]);
  assert.equal(t2.toolCalls.length, 0);
  assert.equal(t2.finishReason, 'stop');
  assert.ok(t2.text.includes('los project'));
});
