import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireProviderDefaults } from './provider-defaults.js';
import { scanEnvKeys, scanGrokAccount, scanKimiCode } from './discovery/scanners.js';

import {
  ccSwitchProviderFromRow,
  describeProviderReadiness,
  parseCodexRouteConfig,
  parseGrokbuildConfig,
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

test('Codex route config recognises the current packyapi.ai endpoint as packycode', () => {
  // name is deliberately not "packycode": recognition must come from the URL,
  // otherwise a suffix-locked check silently stops matching when the endpoint
  // moves to another TLD of the same family.
  const route = parseCodexRouteConfig(`
model_provider = "custom"
model = "gpt-5.5"

[model_providers.custom]
name = "custom"
base_url = "https://www.packyapi.ai/v1"
`);

  assert.equal(route.providerName, 'packycode');
  assert.equal(route.baseUrl, 'https://www.packyapi.ai/v1');
});

test('packycode default endpoint is not the unusable legacy packyapi.com host', () => {
  const host = new URL(requireProviderDefaults('packycode').baseUrl).host;
  assert.ok(
    !host.endsWith('packyapi.com'),
    `packycode must not default to ${host}: the legacy host resolves to a poisoned address on some resolvers and is answered with HTTP 403 in front of the origin`,
  );
  assert.match(host, /^(www\.)?packyapi\.ai$|^(cf|slb-v1)\.api\.fan$/);
});

test('cc-switch grokbuild PackyCode imports as packycode with responses shape', () => {
  const toml = `
[models]
default = "grok-4.5"

[model."grok-4.5"]
model = "grok-4.5"
name = "PackyCode"
api_backend = "responses"
api_key = "sk-packy-grok-test"
context_window = 500000

[endpoints]
models_base_url = "https://slb-v1.api.fan/v1"
`;
  const parsed = parseGrokbuildConfig(toml);
  assert.equal(parsed.defaultModel, 'grok-4.5');
  assert.equal(parsed.apiBackend, 'responses');
  assert.equal(parsed.baseUrl, 'https://slb-v1.api.fan/v1');
  assert.equal(parsed.apiKey, 'sk-packy-grok-test');

  const provider = ccSwitchProviderFromRow({
    app_type: 'grokbuild',
    name: 'PackyCode',
    is_current: 1,
    settings_config: JSON.stringify({ config: toml }),
  });
  assert.equal(provider?.name, 'packycode');
  assert.equal(provider?.defaultModel, 'grok-4.5');
  assert.equal(provider?.apiShape, 'openai-responses');
  assert.equal(provider?.baseUrl, 'https://slb-v1.api.fan/v1');
  assert.equal(provider?.prefer, true);
  assert.equal(provider?.source, 'cc-switch/grokbuild/PackyCode');
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

// 2026-10-12：cc-switch 的 claude 账户把 Claude Code 的方括号后缀写进了 model 值
// （实测 `ANTHROPIC_DEFAULT_OPUS_MODEL=anthropic/claude-opus-5.5[1M]`）。
// 那是**客户端内部命名**，当 API model id 用会 **404 invalid_model**
// （同一天实测：`anthropic/claude-opus-5.5` → 200，带 `[1M]` → 404）。
//
// ⚠️ 可达性：`ccSwitchProviderFromRow` 只把 **deepseek / minimax** 形状的 claude 行
// 映射成 provider（其余返回 null，例如 `zenmuxcc-*`）⇒ 今天那条 `[1M]` 值**进不了 los**。
// 所以这是个**防御性**修复：它保护"将来某条 deepseek/minimax 行带上 `[1M]`"的情况。
// 同理，`-free` 这类**真**后缀必须原样保留。
test('cc-switch Claude rows strip the Claude Code [1M] suffix from the model id', () => {
  const minimaxSuffixed = ccSwitchProviderFromRow({
    app_type: 'claude',
    name: 'MiniMax',
    is_current: 0,
    settings_config: JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'minimax-key',
        ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
        ANTHROPIC_MODEL: 'MiniMax-M3[1M]',
      },
    }),
  });
  assert.equal(minimaxSuffixed?.name, 'minimax');
  assert.equal(minimaxSuffixed?.defaultModel, 'MiniMax-M3');

  // `ANTHROPIC_MODEL` 缺席时回落到 SONNET 那两个变量，同样要剥。
  const deepseekViaSonnet = ccSwitchProviderFromRow({
    app_type: 'claude',
    name: 'DeepSeek',
    is_current: 1,
    settings_config: JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'deepseek-key',
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro[1M]',
      },
    }),
  });
  assert.equal(deepseekViaSonnet?.defaultModel, 'deepseek-v4-pro');

  // 反例：`-free` 是真后缀，不能被剥；不含方括号的值原样保留。
  const realSuffix = ccSwitchProviderFromRow({
    app_type: 'claude',
    name: 'MiniMax',
    is_current: 0,
    settings_config: JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'minimax-key',
        ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
        ANTHROPIC_MODEL: 'MiniMax-M3-free',
      },
    }),
  });
  assert.equal(realSuffix?.defaultModel, 'MiniMax-M3-free');
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

test('Grok account discovery reports a redacted usable external login', () => {
  const candidate = scanGrokAccount({
    env: {
      GROK_AUTH: JSON.stringify({
        key: 'fixture-token-must-not-leak',
        refresh_token: 'fixture-refresh-must-not-leak',
        auth_mode: 'oidc',
        email: 'fixture@example.test',
        expires_at: '2026-08-18T00:00:00.000Z',
      }),
    },
    nowMs: Date.parse('2026-07-18T00:00:00.000Z'),
    cliInstalled: true,
  });

  assert.deepEqual(candidate, {
    candidateId: 'xai-grok-default',
    provider: 'xai',
    runtimeKind: 'grok',
    available: true,
    cliInstalled: true,
    authMode: 'oidc',
    sourceKind: 'inline_env',
    reason: null,
  });
  const serialized = JSON.stringify(candidate);
  assert.doesNotMatch(serialized, /fixture-token|fixture-refresh|fixture@example/);
});

test('Grok account discovery reads the default store and rejects expired credentials', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'los-grok-discovery-'));
  const grokHome = join(homeDir, '.grok');
  mkdirSync(grokHome);
  writeFileSync(join(grokHome, 'auth.json'), JSON.stringify({
    'https://accounts.x.ai/sign-in': {
      key: 'expired-fixture-token',
      auth_mode: 'oidc',
      expires_at: '2026-07-17T00:00:00.000Z',
    },
  }));
  try {
    const candidate = scanGrokAccount({
      env: {},
      homeDir,
      nowMs: Date.parse('2026-07-18T00:00:00.000Z'),
      cliInstalled: true,
    });
    assert.equal(candidate.available, false);
    assert.equal(candidate.authMode, 'oidc');
    assert.equal(candidate.sourceKind, 'default_home');
    assert.equal(candidate.reason, 'grok_auth_expired');
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('Grok account discovery fails closed for malformed auth JSON', () => {
  const candidate = scanGrokAccount({
    env: { GROK_AUTH: '{not-json' },
    cliInstalled: true,
  });
  assert.equal(candidate.available, false);
  assert.equal(candidate.reason, 'grok_auth_malformed');
});

// ── Kimi Code subscription discovery ────────────────────

test('Kimi Code discovery reports an OAuth provider when the subscription file exists', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'los-kimi-discovery-'));
  mkdirSync(join(homeDir, '.kimi-code', 'credentials'), { recursive: true });
  writeFileSync(join(homeDir, '.kimi-code', 'credentials', 'kimi-code.json'), JSON.stringify({
    access_token: 'fixture-access',
    refresh_token: 'fixture-refresh',
    expires_at: Math.floor(Date.now() / 1000) + 600,
  }));
  try {
    const providers = scanKimiCode({ homeDir });
    assert.equal(providers.length, 1);
    const kimi = providers[0];
    assert.equal(kimi.name, 'kimi');
    assert.equal(kimi.baseUrl, 'https://api.kimi.com/coding/v1');
    assert.equal(kimi.defaultModel, 'kimi-k3');
    assert.equal(kimi.authMode, 'oauth');
    assert.equal(kimi.available, true);
    assert.equal(kimi.sourceTool, 'kimi');
    assert.equal(kimi.importable, true);
    assert.equal(kimi.apiKey, undefined);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('Kimi Code discovery treats a missing refresh_token as unavailable', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'los-kimi-discovery-'));
  mkdirSync(join(homeDir, '.kimi-code', 'credentials'), { recursive: true });
  writeFileSync(join(homeDir, '.kimi-code', 'credentials', 'kimi-code.json'), JSON.stringify({
    access_token: 'fixture-access',
    expires_at: Math.floor(Date.now() / 1000) + 600,
  }));
  try {
    const providers = scanKimiCode({ homeDir });
    assert.equal(providers.length, 1);
    assert.equal(providers[0].available, false);
    assert.match(providers[0].note ?? '', /no refresh_token/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('Kimi Code discovery returns nothing when credentials are absent or malformed', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'los-kimi-discovery-'));
  mkdirSync(join(homeDir, '.kimi-code', 'credentials'), { recursive: true });
  writeFileSync(join(homeDir, '.kimi-code', 'credentials', 'kimi-code.json'), '{not-json');
  try {
    assert.deepEqual(scanKimiCode({ homeDir }), []);
    assert.deepEqual(scanKimiCode({ homeDir: join(homeDir, 'missing') }), []);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
