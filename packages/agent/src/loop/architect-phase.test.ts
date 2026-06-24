/**
 * Regression tests for the Architect/Editor architect front-matter phase.
 *
 * The architect phase is a no-tools, reasoning-first loop that produces a
 * natural-language plan terminated by `---plan-end---`. These tests pin:
 *   1. Plan-end marker detection stops the loop early and is stripped.
 *   2. maxArchitectTurns cap without the marker → truncated=true, partial plan.
 *   3. Natural stop (finish_reason='stop') without marker → truncated=false.
 *   4. The architect is never offered tools (second chat arg is undefined).
 *   5. Multi-turn accumulation concatenates architect output.
 *
 * See loop/architect-phase.ts and ADR 0007.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runArchitectPhase, PLAN_END_MARKER, DEFAULT_MAX_ARCHITECT_TURNS } from './architect-phase.js';
import type { Provider, ProviderResponse, Message, ToolDef } from '../providers/index.js';

// ── Mock provider ────────────────────────────────────────

interface MockProviderConfig {
  /** Responses to return, one per chat call (cycled if exhausted). */
  responses: ProviderResponse[];
  /** Captures each chat call's tools argument (must always be undefined). */
  toolsArgs: (ToolDef[] | undefined)[];
  /** Captures each chat call's message list. */
  messagesArgs: Message[][];
}

function makeMockProvider(cfg: MockProviderConfig): Provider {
  let callIdx = 0;
  const profile = { name: 'mock', model: 'mock-model' } as unknown as Provider['profile'];
  return {
    name: 'mock-architect',
    profile,
    async chat(messages: Message[], tools?: ToolDef[]): Promise<ProviderResponse> {
      cfg.messagesArgs.push(messages);
      cfg.toolsArgs.push(tools);
      const res = cfg.responses[callIdx] ?? cfg.responses[cfg.responses.length - 1];
      callIdx++;
      return res;
    },
  };
}

const noopEmit = async () => {};

// ── Tests ────────────────────────────────────────────────

test('plan-end marker stops the loop early and is stripped from the plan', async () => {
  const captured: MockProviderConfig = { responses: [], toolsArgs: [], messagesArgs: [] };
  captured.responses = [
    { text: `Step 1: do X.\nStep 2: do Y.\n${PLAN_END_MARKER}`, toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 }, model: 'mock', finishReason: 'stop' },
  ];
  const provider = makeMockProvider(captured);

  const result = await runArchitectPhase({
    provider, prompt: 'build a feature', maxArchitectTurns: 3, emitEvent: noopEmit,
  });

  assert.equal(result.turns, 1, 'should stop after the marker turn');
  assert.equal(result.truncated, false);
  assert.ok(!result.plan.includes(PLAN_END_MARKER), 'marker must be stripped');
  assert.match(result.plan, /Step 1: do X/);
  assert.match(result.plan, /Step 2: do Y/);
});

test('maxArchitectTurns cap without marker → truncated=true, partial plan returned', async () => {
  const captured: MockProviderConfig = { responses: [], toolsArgs: [], messagesArgs: [] };
  // Never emits the marker, never a natural stop — loops until cap.
  captured.responses = [
    { text: 'thinking about it...', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 }, model: 'mock', finishReason: 'length' },
    { text: ' still thinking...', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 }, model: 'mock', finishReason: 'length' },
  ];
  const provider = makeMockProvider(captured);

  const result = await runArchitectPhase({
    provider, prompt: 'build a feature', maxArchitectTurns: 2, emitEvent: noopEmit,
  });

  assert.equal(result.turns, 2);
  assert.equal(result.truncated, true);
  assert.match(result.plan, /thinking about it/);
  assert.match(result.plan, /still thinking/);
});

test('natural stop (finishReason=stop) without marker → truncated=false', async () => {
  const captured: MockProviderConfig = { responses: [], toolsArgs: [], messagesArgs: [] };
  captured.responses = [
    { text: 'A short plan with no marker.', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 }, model: 'mock', finishReason: 'stop' },
  ];
  const provider = makeMockProvider(captured);

  const result = await runArchitectPhase({
    provider, prompt: 'build a feature', maxArchitectTurns: 3, emitEvent: noopEmit,
  });

  assert.equal(result.turns, 1);
  assert.equal(result.truncated, false, 'natural stop should not be flagged truncated');
  assert.equal(result.plan, 'A short plan with no marker.');
});

test('architect is never offered tools — chat tools arg is always undefined', async () => {
  const captured: MockProviderConfig = { responses: [], toolsArgs: [], messagesArgs: [] };
  captured.responses = [
    { text: `plan\n${PLAN_END_MARKER}`, toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 }, model: 'mock', finishReason: 'stop' },
  ];
  const provider = makeMockProvider(captured);

  await runArchitectPhase({
    provider, prompt: 'build a feature', maxArchitectTurns: 2, emitEvent: noopEmit,
  });

  assert.equal(captured.toolsArgs.length, 1);
  assert.equal(captured.toolsArgs[0], undefined, 'architect chat must receive no tools');
});

test('multi-turn accumulation concatenates architect output until marker', async () => {
  const captured: MockProviderConfig = { responses: [], toolsArgs: [], messagesArgs: [] };
  captured.responses = [
    { text: 'Part 1.', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 }, model: 'mock', finishReason: 'length' },
    { text: ' Part 2.', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 }, model: 'mock', finishReason: 'length' },
    { text: ` Part 3.\n${PLAN_END_MARKER}`, toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 }, model: 'mock', finishReason: 'stop' },
  ];
  const provider = makeMockProvider(captured);

  const result = await runArchitectPhase({
    provider, prompt: 'build a feature', maxArchitectTurns: 5, emitEvent: noopEmit,
  });

  assert.equal(result.turns, 3);
  assert.equal(result.truncated, false);
  assert.equal(result.plan, 'Part 1. Part 2. Part 3.');
});

test('default maxArchitectTurns is 2', () => {
  assert.equal(DEFAULT_MAX_ARCHITECT_TURNS, 2);
});

test('architect messages start with ARCHITECT_PROMPT system message + user prompt', async () => {
  const captured: MockProviderConfig = { responses: [], toolsArgs: [], messagesArgs: [] };
  captured.responses = [
    { text: `plan\n${PLAN_END_MARKER}`, toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 }, model: 'mock', finishReason: 'stop' },
  ];
  const provider = makeMockProvider(captured);

  await runArchitectPhase({
    provider, prompt: 'do the thing', maxArchitectTurns: 1, emitEvent: noopEmit,
  });

  const firstCallMessages = captured.messagesArgs[0];
  assert.equal(firstCallMessages[0].role, 'system');
  assert.match(firstCallMessages[0].content, /software architect/i);
  assert.equal(firstCallMessages[1].role, 'user');
  assert.equal(firstCallMessages[1].content, 'do the thing');
});
