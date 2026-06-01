import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAnthropicModelSettings,
  buildOpenAIModelSettings,
  normalizeModelSettings,
} from './model-settings.js';

test('normalizeModelSettings clamps common runtime parameters', () => {
  const settings = normalizeModelSettings({
    temperature: '3',
    top_p: '0.7',
    max_tokens: '4096',
    presence_penalty: '-3',
    frequencyPenalty: 1.5,
  });

  assert.deepEqual(settings, {
    temperature: 2,
    topP: 0.7,
    maxTokens: 4096,
    presencePenalty: -2,
    frequencyPenalty: 1.5,
  });
});

test('provider model setting builders emit protocol-specific field names', () => {
  const settings = normalizeModelSettings({
    temperature: 0.2,
    topP: 0.9,
    maxTokens: 2048,
    presencePenalty: 0.1,
    frequencyPenalty: 0.2,
  });

  assert.deepEqual(buildOpenAIModelSettings(settings), {
    temperature: 0.2,
    top_p: 0.9,
    max_tokens: 2048,
    presence_penalty: 0.1,
    frequency_penalty: 0.2,
  });
  assert.deepEqual(buildAnthropicModelSettings(settings, 8192), {
    max_tokens: 2048,
    temperature: 0.2,
    top_p: 0.9,
  });
});

test('empty model settings are omitted and anthropic keeps its fallback max token limit', () => {
  assert.equal(normalizeModelSettings({}), undefined);
  assert.deepEqual(buildOpenAIModelSettings(undefined), {});
  assert.deepEqual(buildAnthropicModelSettings(undefined, 8192), { max_tokens: 8192 });
});
