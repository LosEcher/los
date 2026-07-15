import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listLocalProviderDefaults,
  providerDefaultsForApiKeyEnv,
  resolveProviderDefaults,
} from './provider-defaults.js';

test('provider defaults resolve known providers without an unknown fallback', () => {
  assert.equal(resolveProviderDefaults('deepseek')?.defaultModel, 'deepseek-v4-flash');
  assert.equal(resolveProviderDefaults('xai')?.baseUrl, 'https://api.x.ai/v1');
  assert.equal(resolveProviderDefaults('unknown-provider'), undefined);
});

test('provider API key and local endpoint discovery derive from the catalog', () => {
  assert.equal(providerDefaultsForApiKeyEnv('DASHSCOPE_API_KEY')?.name, 'qwen');
  assert.equal(providerDefaultsForApiKeyEnv('XAI_API_KEY')?.defaults.defaultModel, 'grok-4.3');
  const local = listLocalProviderDefaults();
  assert.deepEqual(local.map(entry => entry.name), ['ollama', 'lmstudio', 'vllm', 'llamacpp', 'localai']);
  assert.equal(local.find(entry => entry.name === 'ollama')?.baseUrl, resolveProviderDefaults('ollama')?.baseUrl);
});
