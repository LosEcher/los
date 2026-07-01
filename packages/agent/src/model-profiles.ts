export type ProviderProtocol = 'openai' | 'anthropic';
export type ApiShape = 'openai-chat-completions' | 'openai-responses' | 'anthropic-messages';
export type ToolCallRepairMode = 'none' | 'json-loose';
export type CachePolicy = 'none' | 'prompt-cache-read';
export type VisionCapabilityMode = 'none' | 'native' | 'proxy';
export type SessionAffinity = 'none' | 'provider' | 'model' | 'account';

/** Transport hints for a provider/model. */
export type TransportHint = 'sse' | 'websocket' | 'http-stream' | 'auto';

export interface ModelPricing {
  /** USD per 1M prompt (input) tokens. */
  promptTokenCostPer1M: number;
  /** USD per 1M completion (output) tokens. */
  completionTokenCostPer1M: number;
  /** USD per 1M cache-hit tokens (typically cheaper than prompt). */
  cacheHitTokenCostPer1M: number;
}

export interface ModelCapabilityProfile {
  modelAliases: string[];
  reasoning: {
    supported: boolean;
    parameter?: string;
  };
  vision: {
    supported: boolean;
    mode: VisionCapabilityMode;
    proxyProvider?: string;
  };
  tools: {
    supported: boolean;
    parallelCalls: boolean;
    streaming: boolean;
    repair: ToolCallRepairMode;
  };
  cache: {
    policy: CachePolicy;
    promptCacheRead: boolean;
  };
  session: {
    affinity: SessionAffinity;
    sticky: boolean;
  };
  routing: {
    protocol: ProviderProtocol;
    apiShape: ApiShape;
    transportHints: TransportHint[];
  };
}

export interface ModelProfile {
  provider: string;
  protocol: ProviderProtocol;
  apiShape: ApiShape;
  baseUrl: string;
  model: string;
  supportsTools: boolean;
  supportsParallelToolCalls: boolean;
  supportsReasoning: boolean;
  reasoningParam?: string;
  modelAliases?: string[];
  supportsToolStreaming?: boolean;
  supportsVision?: boolean;
  visionMode?: VisionCapabilityMode;
  visionProxyProvider?: string;
  sessionAffinity?: SessionAffinity;
  cachePolicy: CachePolicy;
  toolCallRepair: ToolCallRepairMode;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  defaultTemperature?: number;
  usageMapping: {
    promptTokens: string[];
    completionTokens: string[];
    cacheHitTokens: string[];
    cacheMissTokens: string[];
    totalTokens: string[];
  };
  retryPolicy: {
    retryableStatusCodes: number[];
  };
  knownFailurePatterns: string[];
  /** Optional pricing data for cost estimation. When absent, cost is not calculated. */
  pricing?: ModelPricing;
  /** Transport hints — what transport protocols the provider supports. */
  transportHints?: TransportHint[];
  /** Normalized capability read model for scheduler and compatibility harnesses. */
  capabilities?: ModelCapabilityProfile;
}

export interface ModelExecutionSummary {
  provider: string;
  protocol: ProviderProtocol;
  apiShape: ApiShape;
  model: string;
  supportsTools: boolean;
  supportsParallelToolCalls: boolean;
  supportsReasoning: boolean;
  reasoningParam?: string;
  cachePolicy: CachePolicy;
  toolCallRepair: ToolCallRepairMode;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  defaultTemperature?: number;
  capabilities: ModelCapabilityProfile;
}

export interface ResolveModelProfileOptions {
  baseUrl?: string;
  model?: string;
  defaultModel?: string;
  apiShape?: ApiShape;
}

const OPENAI_USAGE_MAPPING = {
  promptTokens: ['usage.prompt_tokens', 'usage.input_tokens'],
  completionTokens: ['usage.completion_tokens', 'usage.output_tokens'],
  cacheHitTokens: ['usage.prompt_cache_hit_tokens', 'usage.cache_read_input_tokens'],
  cacheMissTokens: ['usage.prompt_cache_miss_tokens', 'usage.cache_creation_input_tokens'],
  totalTokens: ['usage.total_tokens'],
};

const ANTHROPIC_USAGE_MAPPING = {
  promptTokens: ['usage.input_tokens'],
  completionTokens: ['usage.output_tokens'],
  cacheHitTokens: ['usage.cache_read_input_tokens'],
  cacheMissTokens: ['usage.cache_creation_input_tokens'],
  totalTokens: [],
};

const DEFAULT_RETRY_POLICY = {
  retryableStatusCodes: [408, 409, 429, 500, 502, 503, 504],
};

export const MODEL_PROFILES: Record<string, ModelProfile> = {
  deepseek: {
    provider: 'deepseek',
    protocol: 'openai',
    apiShape: 'openai-chat-completions',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash',
    supportsTools: true,
    supportsParallelToolCalls: false,
    supportsReasoning: true,
    reasoningParam: 'reasoning_content',
    modelAliases: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-reasoner'],
    supportsToolStreaming: true,
    sessionAffinity: 'provider',
    cachePolicy: 'prompt-cache-read',
    toolCallRepair: 'json-loose',
    usageMapping: OPENAI_USAGE_MAPPING,
    retryPolicy: DEFAULT_RETRY_POLICY,
    knownFailurePatterns: ['malformed_tool_call_arguments'],
    pricing: { promptTokenCostPer1M: 1.10, completionTokenCostPer1M: 4.40, cacheHitTokenCostPer1M: 0.14 },
    transportHints: ['sse'],
  },
  openai: {
    provider: 'openai',
    protocol: 'openai',
    apiShape: 'openai-chat-completions',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    supportsTools: true,
    supportsParallelToolCalls: true,
    supportsReasoning: false,
    modelAliases: ['gpt-5.5'],
    supportsToolStreaming: true,
    cachePolicy: 'none',
    toolCallRepair: 'none',
    usageMapping: OPENAI_USAGE_MAPPING,
    retryPolicy: DEFAULT_RETRY_POLICY,
    knownFailurePatterns: [],
    pricing: { promptTokenCostPer1M: 2.50, completionTokenCostPer1M: 10.00, cacheHitTokenCostPer1M: 1.25 },
  },
  packycode: {
    provider: 'packycode',
    protocol: 'openai',
    apiShape: 'openai-chat-completions',
    baseUrl: 'https://www.packyapi.com/v1',
    model: 'gpt-5.5',
    supportsTools: true,
    supportsParallelToolCalls: false,
    supportsReasoning: false,
    modelAliases: ['gpt-5.5'],
    supportsToolStreaming: false,
    cachePolicy: 'none',
    toolCallRepair: 'none',
    usageMapping: OPENAI_USAGE_MAPPING,
    retryPolicy: DEFAULT_RETRY_POLICY,
    knownFailurePatterns: [],
  },
  codex: {
    provider: 'codex',
    protocol: 'openai',
    apiShape: 'openai-chat-completions',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    supportsTools: true,
    supportsParallelToolCalls: true,
    supportsReasoning: true,
    reasoningParam: 'reasoning_effort',
    modelAliases: ['gpt-5.5', 'gpt-5.4'],
    supportsToolStreaming: true,
    sessionAffinity: 'provider',
    cachePolicy: 'prompt-cache-read',
    toolCallRepair: 'none',
    usageMapping: OPENAI_USAGE_MAPPING,
    retryPolicy: DEFAULT_RETRY_POLICY,
    knownFailurePatterns: [],
    pricing: { promptTokenCostPer1M: 2.50, completionTokenCostPer1M: 10.00, cacheHitTokenCostPer1M: 1.25 },
  },
  groq: openAICompatibleProfile('groq', 'https://api.groq.com/openai/v1', 'llama-3.1-70b-versatile'),
  together: openAICompatibleProfile('together', 'https://api.together.xyz/v1', 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo'),
  openrouter: openAICompatibleProfile('openrouter', 'https://openrouter.ai/api/v1', 'openai/gpt-4o'),
  moonshot: openAICompatibleProfile('moonshot', 'https://api.moonshot.cn/v1', 'moonshot-v1-8k'),
  zhipu: openAICompatibleProfile('zhipu', 'https://open.bigmodel.cn/api/paas/v4', 'glm-4'),
  qwen: openAICompatibleProfile('qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-max'),
  ollama: openAICompatibleProfile('ollama', 'http://127.0.0.1:11434/v1', 'llama3.1'),
  lmstudio: openAICompatibleProfile('lmstudio', 'http://127.0.0.1:1234/v1', '(auto)'),
  vllm: openAICompatibleProfile('vllm', 'http://127.0.0.1:8000/v1', '(auto)'),
  anthropic: anthropicProfile('anthropic', 'https://api.anthropic.com', 'claude-sonnet-4-20250514'),
  claude: anthropicProfile('claude', 'https://api.anthropic.com', 'claude-sonnet-4-20250514'),
  'deepseek-anthropic': anthropicProfile('deepseek-anthropic', 'https://api.deepseek.com/anthropic', 'deepseek-v4-pro'),
  minimax: anthropicProfile('minimax', 'https://api.minimaxi.com/anthropic', 'MiniMax-M3'),
  xai: {
    provider: 'xai',
    protocol: 'openai',
    apiShape: 'openai-chat-completions',
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-4.3',
    supportsTools: true,
    supportsParallelToolCalls: true,
    supportsReasoning: true,
    reasoningParam: 'reasoning_effort',
    modelAliases: [
      'grok-4.3',
      'grok-build-0.1',
      'grok-4.20-0309-reasoning',
      'grok-4.20-0309-non-reasoning',
      'grok-code-fast-1',
      'grok-3-mini',
      'grok-4-fast',
      'grok-composer-2.5-fast',
    ],
    supportsToolStreaming: true,
    cachePolicy: 'prompt-cache-read',
    toolCallRepair: 'none',
    maxInputTokens: 1_000_000,
    usageMapping: OPENAI_USAGE_MAPPING,
    retryPolicy: DEFAULT_RETRY_POLICY,
    knownFailurePatterns: [],
    pricing: {
      promptTokenCostPer1M: 1.00,
      completionTokenCostPer1M: 2.00,
      cacheHitTokenCostPer1M: 0.25,
    },
  },
};

export function resolveModelProfile(
  provider: string,
  options: ResolveModelProfileOptions = {},
): ModelProfile {
  const base = MODEL_PROFILES[provider] ?? openAICompatibleProfile(provider, 'https://api.openai.com/v1', options.defaultModel ?? 'gpt-4o');
  const resolved = {
    ...base,
    baseUrl: options.baseUrl ?? base.baseUrl,
    model: options.model ?? base.model ?? options.defaultModel ?? 'gpt-4o',
    apiShape: options.apiShape ?? base.apiShape,
  };
  return {
    ...resolved,
    capabilities: resolveModelCapabilityProfile(resolved),
  };
}

export function summarizeModelProfile(profile: ModelProfile): ModelExecutionSummary {
  return {
    provider: profile.provider,
    protocol: profile.protocol,
    apiShape: profile.apiShape,
    model: profile.model,
    supportsTools: profile.supportsTools,
    supportsParallelToolCalls: profile.supportsParallelToolCalls,
    supportsReasoning: profile.supportsReasoning,
    reasoningParam: profile.reasoningParam,
    cachePolicy: profile.cachePolicy,
    toolCallRepair: profile.toolCallRepair,
    maxInputTokens: profile.maxInputTokens,
    maxOutputTokens: profile.maxOutputTokens,
    defaultTemperature: profile.defaultTemperature,
    capabilities: resolveModelCapabilityProfile(profile),
  };
}

export function resolveModelCapabilityProfile(profile: ModelProfile): ModelCapabilityProfile {
  const transportHints: TransportHint[] = profile.transportHints?.length ? profile.transportHints : ['http-stream'];
  const visionMode = profile.visionMode ?? (profile.supportsVision ? 'native' : 'none');
  const sessionAffinity = profile.sessionAffinity ?? (profile.cachePolicy === 'prompt-cache-read' ? 'provider' : 'none');
  return {
    modelAliases: uniqueStrings([profile.model, ...(profile.modelAliases ?? [])]),
    reasoning: {
      supported: profile.supportsReasoning,
      parameter: profile.reasoningParam,
    },
    vision: {
      supported: profile.supportsVision === true,
      mode: visionMode,
      proxyProvider: profile.visionProxyProvider,
    },
    tools: {
      supported: profile.supportsTools,
      parallelCalls: profile.supportsParallelToolCalls,
      streaming: profile.supportsToolStreaming === true,
      repair: profile.toolCallRepair,
    },
    cache: {
      policy: profile.cachePolicy,
      promptCacheRead: profile.cachePolicy === 'prompt-cache-read',
    },
    session: {
      affinity: sessionAffinity,
      sticky: sessionAffinity !== 'none',
    },
    routing: {
      protocol: profile.protocol,
      apiShape: profile.apiShape,
      transportHints,
    },
  };
}

function openAICompatibleProfile(provider: string, baseUrl: string, model: string): ModelProfile {
  return {
    provider,
    protocol: 'openai',
    apiShape: 'openai-chat-completions',
    baseUrl,
    model,
    supportsTools: true,
    supportsParallelToolCalls: false,
    supportsReasoning: false,
    modelAliases: [model],
    cachePolicy: 'none',
    toolCallRepair: 'none',
    usageMapping: OPENAI_USAGE_MAPPING,
    retryPolicy: DEFAULT_RETRY_POLICY,
    knownFailurePatterns: [],
  };
}

function anthropicProfile(provider: string, baseUrl: string, model: string): ModelProfile {
  return {
    provider,
    protocol: 'anthropic',
    apiShape: 'anthropic-messages',
    baseUrl,
    model,
    supportsTools: true,
    supportsParallelToolCalls: false,
    supportsReasoning: true,
    reasoningParam: 'thinking',
    modelAliases: [model],
    supportsToolStreaming: true,
    sessionAffinity: 'provider',
    cachePolicy: 'prompt-cache-read',
    toolCallRepair: 'none',
    usageMapping: ANTHROPIC_USAGE_MAPPING,
    retryPolicy: DEFAULT_RETRY_POLICY,
    knownFailurePatterns: [],
    pricing: { promptTokenCostPer1M: 3.00, completionTokenCostPer1M: 15.00, cacheHitTokenCostPer1M: 0.30 },
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

// ── Cost Estimation ─────────────────────────────────────

export interface CostEstimate {
  /** Total estimated cost in USD. */
  totalCostUsd: number;
  /** Prompt (input) token cost. */
  promptCostUsd: number;
  /** Completion (output) token cost. */
  completionCostUsd: number;
  /** Cache-hit token cost. */
  cacheHitCostUsd: number;
  /** Savings from cache hits vs regular prompt pricing. */
  cacheSavingsUsd: number;
}

/**
 * Calculate estimated cost from token usage and model pricing.
 * Returns null when pricing data is unavailable.
 */
export function calculateCost(
  usage: { promptTokens: number; completionTokens: number; cacheHitTokens?: number; cacheMissTokens?: number },
  pricing: ModelPricing,
): CostEstimate {
  const promptCost = (usage.promptTokens / 1_000_000) * pricing.promptTokenCostPer1M;
  const completionCost = (usage.completionTokens / 1_000_000) * pricing.completionTokenCostPer1M;
  const cacheHitCost = ((usage.cacheHitTokens ?? 0) / 1_000_000) * pricing.cacheHitTokenCostPer1M;
  // Cache-miss tokens are billed at regular prompt rate and are already included in promptTokens
  const cacheSavings = ((usage.cacheHitTokens ?? 0) / 1_000_000) * (pricing.promptTokenCostPer1M - pricing.cacheHitTokenCostPer1M);
  return {
    totalCostUsd: promptCost + completionCost + cacheHitCost,
    promptCostUsd: promptCost,
    completionCostUsd: completionCost,
    cacheHitCostUsd: cacheHitCost,
    cacheSavingsUsd: cacheSavings,
  };
}

/**
 * Calculate estimated cost from token usage and a model profile.
 * Returns null when the profile has no pricing data.
 */
export function estimateCost(
  usage: { promptTokens: number; completionTokens: number; cacheHitTokens?: number; cacheMissTokens?: number },
  profile: ModelProfile,
): CostEstimate | null {
  if (!profile.pricing) return null;
  return calculateCost(usage, profile.pricing);
}
