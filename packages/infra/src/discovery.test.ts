import test from 'node:test';
import assert from 'node:assert/strict';
import { requireProviderDefaults } from './provider-defaults.js';
import { scanEnvKeys } from './discovery/scanners.js';

import {
  ccSwitchProviderFromRow,
  describeProviderReadiness,
  parseCodexRouteConfig,
  providerApiKeyEnv,
  summarizeProviderReadiness,
  type DiscoveredProvider,
} from './discovery.js';

function provider(overrides: Partial<DiscoveredProvider>): DiscoveredProvider {
  return {
    name: 'deepseek',
    apiKey: 'test-key',
    baseUrl: 'https://api.deepseek.com/v1',
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
  assert.equal(providerApiKeyEnv('deepseek-anthropic'), 'DEEPSEEK_API_KEY');
  assert.equal(providerApiKeyEnv('minimax'), 'MINIMAX_API_KEY');
  assert.equal(providerApiKeyEnv('qwen'), 'DASHSCOPE_API_KEY');
  assert.equal(providerApiKeyEnv('local router'), 'LOCAL_ROUTER_API_KEY');
});

test('environment discovery uses canonical provider routing defaults', () => {
  const previousApiKey = process.env.DASHSCOPE_API_KEY;
  const previousBaseUrl = process.env.DASHSCOPE_BASE_URL;
  const previousModel = process.env.DASHSCOPE_MODEL;
  process.env.DASHSCOPE_API_KEY = 'test-key';
  delete process.env.DASHSCOPE_BASE_URL;
  delete process.env.DASHSCOPE_MODEL;
  try {
    const qwen = scanEnvKeys().find(provider => provider.name === 'qwen');
    const defaults = requireProviderDefaults('qwen');
    assert.equal(qwen?.baseUrl, defaults.baseUrl);
    assert.equal(qwen?.defaultModel, defaults.defaultModel);
  } finally {
    if (previousApiKey === undefined) delete process.env.DASHSCOPE_API_KEY;
    else process.env.DASHSCOPE_API_KEY = previousApiKey;
    if (previousBaseUrl === undefined) delete process.env.DASHSCOPE_BASE_URL;
    else process.env.DASHSCOPE_BASE_URL = previousBaseUrl;
    if (previousModel === undefined) delete process.env.DASHSCOPE_MODEL;
    else process.env.DASHSCOPE_MODEL = previousModel;
  }
});

test('Codex route config maps Packy API routes to packycode', () => {
  const route = parseCodexRouteConfig(`
model_provider = "custom"
model = "gpt-5.5"

[model_providers.custom]
name = "packycode"
base_url = "https://www.packyapi.com/v1"
`);

  assert.deepEqual(route, {
    providerName: 'packycode',
    baseUrl: 'https://www.packyapi.com/v1',
    model: 'gpt-5.5',
  });
});

test('cc-switch rows import executable Claude-compatible DeepSeek and MiniMax providers', () => {
  const deepseek = ccSwitchProviderFromRow({
    app_type: 'claude',
    name: 'DeepSeek',
    is_current: 1,
    settings_config: JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'deepseek-key',
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_MODEL: 'deepseek-v4-pro',
      },
    }),
  });
  assert.equal(deepseek?.name, 'deepseek-anthropic');
  assert.equal(deepseek?.baseUrl, 'https://api.deepseek.com/anthropic');
  assert.equal(deepseek?.defaultModel, 'deepseek-v4-pro');
  assert.equal(deepseek?.source, 'cc-switch/claude/DeepSeek');

  const minimax = ccSwitchProviderFromRow({
    app_type: 'claude',
    name: 'MiniMax',
    is_current: 0,
    settings_config: JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'minimax-key',
        ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
        ANTHROPIC_MODEL: 'MiniMax-M3',
      },
    }),
  });
  assert.equal(minimax?.name, 'minimax');
  assert.equal(minimax?.baseUrl, 'https://api.minimaxi.com/anthropic');
  assert.equal(minimax?.defaultModel, 'MiniMax-M3');
  assert.equal(minimax?.source, 'cc-switch/claude/MiniMax');
});

test('cc-switch Codex rows import PackyCode auth without exposing Claude OAuth as Anthropic', () => {
  const provider = ccSwitchProviderFromRow({
    app_type: 'codex',
    name: 'PackyCode',
    is_current: 1,
    settings_config: JSON.stringify({
      auth: JSON.stringify({ OPENAI_API_KEY: 'packy-key' }),
      config: `
model_provider = "custom"
model = "gpt-5.5"

[model_providers.custom]
base_url = "https://www.packyapi.com/v1"
`,
    }),
  });

  assert.equal(provider?.name, 'packycode');
  assert.equal(provider?.apiKey, 'packy-key');
  assert.equal(provider?.baseUrl, 'https://www.packyapi.com/v1');
  assert.equal(provider?.source, 'cc-switch/codex/PackyCode');
});
