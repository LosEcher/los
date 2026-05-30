import test from 'node:test';
import assert from 'node:assert/strict';

import { MODEL_PROFILES, resolveModelProfile } from './model-profiles.js';

test('resolveModelProfile keeps deepseek defaults and overrides', () => {
  const profile = resolveModelProfile('deepseek');
  assert.equal(profile.protocol, 'openai');
  assert.equal(profile.model, 'deepseek-chat');
  assert.equal(profile.toolCallRepair, 'json-loose');
  assert.equal(profile.cachePolicy, 'prompt-cache-read');

  const override = resolveModelProfile('deepseek', {
    baseUrl: 'https://example.invalid',
    model: 'deepseek-reasoner',
  });
  assert.equal(override.baseUrl, 'https://example.invalid');
  assert.equal(override.model, 'deepseek-reasoner');
});

test('resolveModelProfile knows packycode and anthropic routing shapes', () => {
  const packy = resolveModelProfile('packycode');
  assert.equal(packy.protocol, 'openai');
  assert.equal(packy.baseUrl, 'https://www.packyapi.com/v1');
  assert.equal(packy.model, 'gpt-5.5');

  const anthropic = resolveModelProfile('claude');
  assert.equal(anthropic.protocol, 'anthropic');
  assert.equal(anthropic.apiShape, 'anthropic-messages');
  assert.equal(anthropic.supportsReasoning, true);
});

test('model profile registry includes the expected core providers', () => {
  assert.ok(MODEL_PROFILES.deepseek);
  assert.ok(MODEL_PROFILES.openai);
  assert.ok(MODEL_PROFILES.packycode);
});
