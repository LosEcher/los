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

  const deepseekR = describeProviderReadiness(deepseek);
  assert.equal(deepseekR.configuredKey, true);
  assert.equal(deepseekR.ready, true);
  assert.equal(deepseekR.manualSetupRequired, false);
  assert.equal(deepseekR.blocker, null);
  assert.equal(deepseekR.promotionState, 'advisory');
  assert.equal(deepseekR.credentialClass, 'api_key');
  assert.equal(deepseekR.setupAction, null);

  const openaiR = describeProviderReadiness(openai);
  assert.equal(openaiR.configuredKey, true);
  assert.equal(openaiR.ready, true);
  assert.equal(openaiR.promotionState, 'advisory');
  assert.equal(openaiR.credentialClass, 'cli_adapter');

  const anthropicR = describeProviderReadiness(anthropic);
  assert.equal(anthropicR.configuredKey, false);
  assert.equal(anthropicR.ready, false);
  assert.equal(anthropicR.manualSetupRequired, true);
  assert.equal(anthropicR.promotionState, 'blocked');
  assert.ok(anthropicR.blocker?.includes('ANTHROPIC_API_KEY'));
  assert.equal(anthropicR.credentialClass, 'oauth');
  assert.ok(anthropicR.setupAction?.includes('OAuth'));

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
