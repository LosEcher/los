import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeProviderReadiness,
  providerApiKeyEnv,
  summarizeProviderReadiness,
  type DiscoveredProvider,
} from './discovery.js';

function provider(overrides: Partial<DiscoveredProvider>): DiscoveredProvider {
  return {
    name: 'deepseek',
    apiKey: 'test-key',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    available: true,
    source: 'env:DEEPSEEK_API_KEY',
    importable: true,
    ...overrides,
  };
}

test('provider readiness distinguishes configured keys, discovery, ready state, and blockers', () => {
  const deepseek = provider({});
  const openai = provider({
    name: 'openai',
    source: 'codex/auth.json',
    defaultModel: 'gpt-5.5',
  });
  const anthropic = provider({
    name: 'anthropic',
    apiKey: undefined,
    baseUrl: undefined,
    defaultModel: undefined,
    available: false,
    source: 'claude/.claude.json',
    importable: false,
  });

  assert.deepEqual(describeProviderReadiness(deepseek), {
    configuredKey: true,
    discovered: true,
    ready: true,
    manualSetupRequired: false,
    blocker: null,
  });

  assert.deepEqual(describeProviderReadiness(openai), {
    configuredKey: true,
    discovered: true,
    ready: true,
    manualSetupRequired: false,
    blocker: null,
  });

  assert.deepEqual(describeProviderReadiness(anthropic), {
    configuredKey: false,
    discovered: true,
    ready: false,
    manualSetupRequired: true,
    blocker: 'BLOCKER: ANTHROPIC_API_KEY not set. Ignore if anthropic is not needed.',
  });

  assert.deepEqual(summarizeProviderReadiness([deepseek, openai, anthropic]), {
    configuredKeys: 2,
    discoveredProviders: 3,
    readyProviders: 2,
    manualSetupBlockers: 1,
  });
});

test('provider API key env names use known provider conventions', () => {
  assert.equal(providerApiKeyEnv('anthropic'), 'ANTHROPIC_API_KEY');
  assert.equal(providerApiKeyEnv('deepseek'), 'DEEPSEEK_API_KEY');
  assert.equal(providerApiKeyEnv('qwen'), 'DASHSCOPE_API_KEY');
  assert.equal(providerApiKeyEnv('local router'), 'LOCAL_ROUTER_API_KEY');
});
