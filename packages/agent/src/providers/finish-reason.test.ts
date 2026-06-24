/**
 * Regression tests for cross-provider finish-reason normalization.
 *
 * The bug being fixed: each provider adapter returned `finishReason` in its own
 * native vocabulary — OpenAI Chat Completions (`length`), Anthropic Messages
 * (`max_tokens`), OpenAI Responses API (`incomplete`). The agent loop only
 * checks `finishReason === 'length'` to detect truncation, so Anthropic and
 * Responses providers silently completed with truncated text.
 *
 * `normalizeFinishReason()` is the single boundary where native stop reasons
 * are translated to the canonical vocabulary. These tests pin the mapping for
 * all three provider families. See ADR 0007 (provider loop) and
 * `loop.ts` truncation handling.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFinishReason } from './types.js';

// ── Anthropic Messages API stop_reason ───────────────────

test('anthropic: max_tokens maps to length (truncation)', () => {
  assert.equal(normalizeFinishReason('max_tokens', 'anthropic'), 'length');
});

test('anthropic: end_turn maps to stop', () => {
  assert.equal(normalizeFinishReason('end_turn', 'anthropic'), 'stop');
});

test('anthropic: stop_sequence maps to stop', () => {
  assert.equal(normalizeFinishReason('stop_sequence', 'anthropic'), 'stop');
});

test('anthropic: tool_use maps to tool_calls', () => {
  assert.equal(normalizeFinishReason('tool_use', 'anthropic'), 'tool_calls');
});

test('anthropic: unknown stop_reason passes through for observability', () => {
  assert.equal(normalizeFinishReason('pause_turn', 'anthropic'), 'pause_turn');
});

// ── OpenAI Responses API status ──────────────────────────

test('responses: incomplete maps to length (truncation)', () => {
  assert.equal(normalizeFinishReason('incomplete', 'responses'), 'length');
});

test('responses: completed maps to stop', () => {
  assert.equal(normalizeFinishReason('completed', 'responses'), 'stop');
});

test('responses: failed passes through unchanged', () => {
  assert.equal(normalizeFinishReason('failed', 'responses'), 'failed');
});

test('responses: cancelled passes through unchanged', () => {
  assert.equal(normalizeFinishReason('cancelled', 'responses'), 'cancelled');
});

// ── OpenAI Chat Completions finish_reason ────────────────

test('openai: length passes through (already canonical)', () => {
  assert.equal(normalizeFinishReason('length', 'openai'), 'length');
});

test('openai: stop passes through', () => {
  assert.equal(normalizeFinishReason('stop', 'openai'), 'stop');
});

test('openai: tool_calls passes through', () => {
  assert.equal(normalizeFinishReason('tool_calls', 'openai'), 'tool_calls');
});

test('openai: content_filter passes through', () => {
  assert.equal(normalizeFinishReason('content_filter', 'openai'), 'content_filter');
});

// ── Null / empty guards (all families) ───────────────────

test('all families: undefined native returns undefined', () => {
  assert.equal(normalizeFinishReason(undefined, 'openai'), undefined);
  assert.equal(normalizeFinishReason(undefined, 'anthropic'), undefined);
  assert.equal(normalizeFinishReason(undefined, 'responses'), undefined);
});

test('all families: empty string returns undefined', () => {
  assert.equal(normalizeFinishReason('', 'openai'), undefined);
  assert.equal(normalizeFinishReason('', 'anthropic'), undefined);
  assert.equal(normalizeFinishReason('', 'responses'), undefined);
});
