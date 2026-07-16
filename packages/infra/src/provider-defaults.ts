export interface ProviderDefaults {
  baseUrl: string;
  defaultModel: string;
  apiKeyEnv?: string;
  checkUrl?: string;
}

const PROVIDER_DEFAULTS = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-v4-flash', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  openai: { baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-5.5', apiKeyEnv: 'OPENAI_API_KEY' },
  packycode: { baseUrl: 'https://www.packyapi.com/v1', defaultModel: 'gpt-5.5' },
  codex: { baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-5.5' },
  anthropic: { baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-20250514', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  claude: { baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-20250514' },
  'deepseek-anthropic': { baseUrl: 'https://api.deepseek.com/anthropic', defaultModel: 'deepseek-v4-pro' },
  minimax: { baseUrl: 'https://api.minimaxi.com/anthropic', defaultModel: 'MiniMax-M3', apiKeyEnv: 'MINIMAX_API_KEY' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.1-70b-versatile', apiKeyEnv: 'GROQ_API_KEY' },
  together: { baseUrl: 'https://api.together.xyz/v1', defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', apiKeyEnv: 'TOGETHER_API_KEY' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-4o', apiKeyEnv: 'OPENROUTER_API_KEY' },
  moonshot: { baseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-8k', apiKeyEnv: 'MOONSHOT_API_KEY' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4', apiKeyEnv: 'ZHIPU_API_KEY' },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-max', apiKeyEnv: 'DASHSCOPE_API_KEY' },
  xai: { baseUrl: 'https://api.x.ai/v1', defaultModel: 'grok-4.3', apiKeyEnv: 'XAI_API_KEY' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'llama3.1', checkUrl: 'http://127.0.0.1:11434/api/tags' },
  lmstudio: { baseUrl: 'http://127.0.0.1:1234/v1', defaultModel: '(auto)', checkUrl: 'http://127.0.0.1:1234/v1/models' },
  vllm: { baseUrl: 'http://127.0.0.1:8000/v1', defaultModel: '(auto)', checkUrl: 'http://127.0.0.1:8000/v1/models' },
  llamacpp: { baseUrl: 'http://127.0.0.1:8081/v1', defaultModel: '(auto)', checkUrl: 'http://127.0.0.1:8081/v1/models' },
  localai: { baseUrl: 'http://127.0.0.1:8082/v1', defaultModel: '(auto)', checkUrl: 'http://127.0.0.1:8082/v1/models' },
} as const satisfies Record<string, ProviderDefaults>;

export type KnownProviderName = keyof typeof PROVIDER_DEFAULTS;

export function resolveProviderDefaults(provider: string): ProviderDefaults | undefined {
  return PROVIDER_DEFAULTS[provider.toLowerCase() as KnownProviderName];
}

export function requireProviderDefaults(provider: string): ProviderDefaults {
  const defaults = resolveProviderDefaults(provider);
  if (!defaults) throw new Error(`No canonical defaults registered for provider '${provider}'`);
  return defaults;
}

export function providerDefaultsForApiKeyEnv(envKey: string): { name: KnownProviderName; defaults: ProviderDefaults } | undefined {
  for (const [name, defaults] of Object.entries(PROVIDER_DEFAULTS)) {
    if ('apiKeyEnv' in defaults && defaults.apiKeyEnv === envKey) {
      return { name: name as KnownProviderName, defaults };
    }
  }
  return undefined;
}

export function listProviderDefaults(): Array<{ name: KnownProviderName; defaults: ProviderDefaults }> {
  return Object.entries(PROVIDER_DEFAULTS).map(([name, defaults]) => ({
    name: name as KnownProviderName,
    defaults,
  }));
}

export function listLocalProviderDefaults(): Array<{
  name: KnownProviderName;
  checkUrl: string;
  baseUrl: string;
  defaultModel: string;
}> {
  return Object.entries(PROVIDER_DEFAULTS).flatMap(([name, defaults]) => 'checkUrl' in defaults ? [{
    name: name as KnownProviderName,
    checkUrl: defaults.checkUrl,
    baseUrl: defaults.baseUrl,
    defaultModel: defaults.defaultModel,
  }] : []);
}
