import test from 'node:test';
import assert from 'node:assert/strict';

import { MODEL_PROFILES, resolveModelProfile, summarizeModelProfile } from './model-profiles.js';

test('resolveModelProfile keeps deepseek defaults and overrides', () => {
  const profile = resolveModelProfile('deepseek');
  assert.equal(profile.protocol, 'openai');
  assert.equal(profile.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(profile.model, 'deepseek-v4-flash');
  assert.equal(profile.toolCallRepair, 'json-loose');
  assert.equal(profile.cachePolicy, 'prompt-cache-read');

  const override = resolveModelProfile('deepseek', {
    baseUrl: 'https://example.invalid',
    model: 'deepseek-v4-pro',
  });
  assert.equal(override.baseUrl, 'https://example.invalid');
  assert.equal(override.model, 'deepseek-v4-pro');
});

test('resolveModelProfile knows codex-compatible and anthropic routing shapes', () => {
  const codex = resolveModelProfile('codex');
  assert.equal(codex.protocol, 'openai');
  assert.equal(codex.baseUrl, 'https://api.openai.com/v1');
  assert.equal(codex.model, 'gpt-5.5');

  const anthropic = resolveModelProfile('claude');
  assert.equal(anthropic.protocol, 'anthropic');
  assert.equal(anthropic.apiShape, 'anthropic-messages');
  assert.equal(anthropic.supportsReasoning, true);

  const deepseekAnthropic = resolveModelProfile('deepseek-anthropic');
  assert.equal(deepseekAnthropic.protocol, 'anthropic');
  assert.equal(deepseekAnthropic.baseUrl, 'https://api.deepseek.com/anthropic');

  const minimax = resolveModelProfile('minimax');
  assert.equal(minimax.protocol, 'anthropic');
  assert.equal(minimax.model, 'MiniMax-M3');
});

test('model profile registry includes the expected core providers', () => {
  assert.ok(MODEL_PROFILES.deepseek);
  assert.ok(MODEL_PROFILES.openai);
  assert.ok(MODEL_PROFILES.codex);
  assert.ok(MODEL_PROFILES.packycode);
  assert.ok(MODEL_PROFILES['deepseek-anthropic']);
  assert.ok(MODEL_PROFILES.minimax);
});

test('summarizeModelProfile exposes runtime-relevant model capabilities', () => {
  const summary = summarizeModelProfile(resolveModelProfile('deepseek', {
    model: 'deepseek-v4-pro',
  }));

  assert.equal(summary.provider, 'deepseek');
  assert.equal(summary.model, 'deepseek-v4-pro');
  assert.equal(summary.supportsReasoning, true);
  assert.equal(summary.cachePolicy, 'prompt-cache-read');
  assert.equal(summary.toolCallRepair, 'json-loose');
});
