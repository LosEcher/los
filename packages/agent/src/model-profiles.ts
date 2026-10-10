import {
  requireProviderDefaults,
  resolveProviderDefaults,
} from '@los/infra/provider-defaults';

export type ProviderProtocol = 'openai' | 'anthropic';
export type ApiShape = 'openai-chat-completions' | 'openai-responses' | 'anthropic-messages';
export type ToolCallRepairMode = 'none' | 'json-loose';
export type CachePolicy = 'none' | 'prompt-cache-read';
export type VisionCapabilityMode = 'none' | 'native' | 'proxy';
export type SessionAffinity = 'none' | 'provider' | 'model' | 'account';

/** Transport hints for a provider/model. */
export type TransportHint = 'sse' | 'websocket' | 'http-stream' | 'auto';

export interface ModelPricing {
  /** Off-peak price per 1M cache-miss prompt (input) tokens. */
  promptTokenCostPer1M: number;
  /** Off-peak price per 1M completion (output) tokens. */
  completionTokenCostPer1M: number;
  /** Off-peak price per 1M cache-hit tokens (typically cheaper than prompt). */
  cacheHitTokenCostPer1M: number;
  /** Whether promptTokens already includes cache-hit tokens. */
  promptTokensIncludeCacheHits?: boolean;
  /** Currency of the per-1M prices (default `'usd'`). DeepSeek bills in CNY. */
  currency?: 'cny' | 'usd';
  /**
   * Peak-time multiplier applied inside Beijing peak hours (DeepSeek: 2, since
   * 2026-08-17). Weekends are always off-peak (since 2026-08-23). Default 1 =
   * no peak pricing.
   */
  peakMultiplier?: number;
  /** CNY→USD conversion: CNY per 1 USD (default {@link DEFAULT_CNY_PER_USD}). Cost fields are USD. */
  cnyPerUsd?: number;
  /** Pricing effective date — drift marker for periodic price audits. */
  asOf?: string;
}

/** Default CNY→USD conversion: CNY per 1 USD. PBOC midpoint 2026-08-20/21 was
 * 6.7808/6.7817; round to 6.8 as a stable default. Per-pricing `cnyPerUsd`
 * overrides it; keep in sync with the rate when the midpoint drifts. */
export const DEFAULT_CNY_PER_USD = 6.8;

export type BillingPeriod = 'peak' | 'off-peak';

const BEIJING_HOUR_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hourCycle: 'h23' });
const BEIJING_WEEKDAY_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' });
const BEIJING_DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });

/**
 * 中国法定节假日（北京时间日期，YYYY-MM-DD）。高峰时段在这些日期全天不适用。
 *
 * 真源：国务院办公厅关于 2026 年部分节假日安排的通知（国办发明电〔2025〕7 号）
 * https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html
 * 站点规则见 https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ 脚注 2
 * （"北京时间周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00 为高峰时段"）。
 * 每年国务院公布次年安排后必须更新本表，否则节假日会被按高峰 ×2 多计。
 */
const CHINA_PUBLIC_HOLIDAYS = new Set<string>([
  // 元旦
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 春节
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  // 清明节
  '2026-04-04', '2026-04-05', '2026-04-06',
  // 劳动节
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 端午节
  '2026-06-19', '2026-06-20', '2026-06-21',
  // 中秋节
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 国庆节
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
]);

/**
 * DeepSeek billing period for a timestamp in Beijing time: peak = 09:00-12:00
 * and 14:00-18:00 on weekdays **excluding Chinese public holidays**; weekends
 * (Sat/Sun), public holidays and everything outside peak hours are off-peak.
 * The weekend flat rate applies since 2026-08-23.
 *
 * 节假日平谷为 2026-10-09 计费审计补齐（此前缺失 ⇒ 国庆/中秋被按高峰多计）。
 */
export function billingPeriodAt(at: Date): BillingPeriod {
  if (CHINA_PUBLIC_HOLIDAYS.has(BEIJING_DAY_FMT.format(at))) return 'off-peak';
  const hour = Number(BEIJING_HOUR_FMT.format(at));
  const weekday = BEIJING_WEEKDAY_FMT.format(at);
  if (weekday === 'Sat' || weekday === 'Sun') return 'off-peak';
  if ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)) return 'peak';
  return 'off-peak';
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
  /** Recommended token count at which context compression should trigger.
   *  Provider-specific; based on official recommendations (e.g. Kimi-K3: 300K).
   *  Scheduler picks this up as the default `maxContextTokens` when not overridden. */
  recommendedCompressionTokens?: number;
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
  /** Model-specific pricing overrides resolved after the effective model is selected. */
  pricingByModel?: Record<string, ModelPricing>;
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

// DeepSeek V4.1-Flash billing (CNY per 1M tokens, effective 2026-09-10 12:00
// Beijing): off-peak prices below, peak = off-peak × 2 during Beijing peak hours
// (weekdays 09-12/14-18, excluding Chinese public holidays). Off-peak cache-hit
// input is 1/50 of cache-miss input.
//
// 2026-09-10 站点把 Flash 改名 `deepseek-v4-flash` → `deepseek-flash` 并同步降价
// （1.5/4.5/0.05 → 1.0/4.0/0.02）；旧名仍可调用但路由到 V4.1-Flash 并按 Flash 单价计费。
// 此前本表停留在 8/17 价且未登记新名 —— 未登记会导致 resolveModelProfile 返回无定价、
// 成本静默归零。新增模型名必须同时登记到下方 pricingByModel。
// See https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
const DEEPSEEK_V4_FLASH_PRICING: ModelPricing = {
  currency: 'cny',
  promptTokenCostPer1M: 1,
  completionTokenCostPer1M: 4,
  cacheHitTokenCostPer1M: 0.02,
  promptTokensIncludeCacheHits: true,
  peakMultiplier: 2,
  cnyPerUsd: DEFAULT_CNY_PER_USD,
  asOf: '2026-09-10',
};

const DEEPSEEK_V4_PRO_PRICING: ModelPricing = {
  currency: 'cny',
  promptTokenCostPer1M: 4.5,
  completionTokenCostPer1M: 13.5,
  cacheHitTokenCostPer1M: 0.15,
  promptTokensIncludeCacheHits: true,
  peakMultiplier: 2,
  cnyPerUsd: DEFAULT_CNY_PER_USD,
  asOf: '2026-08-17',
};

export const MODEL_PROFILES: Record<string, ModelProfile> = {
  deepseek: {
    provider: 'deepseek',
    protocol: 'openai',
    apiShape: 'openai-chat-completions',
    baseUrl: requireProviderDefaults('deepseek').baseUrl,
    model: requireProviderDefaults('deepseek').defaultModel,
    supportsTools: true,
    supportsParallelToolCalls: false,
    supportsReasoning: true,
    reasoningParam: 'reasoning_effort',
    modelAliases: ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro'],
    supportsToolStreaming: true,
    sessionAffinity: 'provider',
    cachePolicy: 'prompt-cache-read',
    toolCallRepair: 'json-loose',
    usageMapping: OPENAI_USAGE_MAPPING,
    retryPolicy: DEFAULT_RETRY_POLICY,
    knownFailurePatterns: ['malformed_tool_call_arguments'],
    pricing: DEEPSEEK_V4_FLASH_PRICING,
    pricingByModel: {
      // 现行模型名（2026-09-10 起）
      'deepseek-flash': DEEPSEEK_V4_FLASH_PRICING,
      // 旧名保留：站点仍接受，并按 V4.1-Flash 单价计费（兼容路由）
      'deepseek-v4-flash': DEEPSEEK_V4_FLASH_PRICING,
      'deepseek-v4-flash-vision-exp': DEEPSEEK_V4_FLASH_PRICING,
      'deepseek-v4-pro': DEEPSEEK_V4_PRO_PRICING,
      'deepseek-chat': DEEPSEEK_V4_FLASH_PRICING,
      'deepseek-reasoner': DEEPSEEK_V4_FLASH_PRICING,
    },
    transportHints: ['sse'],
  },
  kimi: {
    provider: 'kimi',
    protocol: 'openai',
    apiShape: 'openai-chat-completions',
    baseUrl: requireProviderDefaults('kimi').baseUrl,
    model: requireProviderDefaults('kimi').defaultModel,
    supportsTools: true,
    supportsParallelToolCalls: true,
    supportsReasoning: true,
    reasoningParam: 'reasoning_effort',
    modelAliases: ['kimi-k3'],
    supportsToolStreaming: true,
    supportsVision: true,
    visionMode: 'native',
    sessionAffinity: 'provider',
    cachePolicy: 'none',
    toolCallRepair: 'json-loose',
    maxInputTokens: 1_048_576,
    maxOutputTokens: 128_000,
    recommendedCompressionTokens: 300_000,
    usageMapping: OPENAI_USAGE_MAPPING,
    retryPolicy: DEFAULT_RETRY_POLICY,
    knownFailurePatterns: [],
    transportHints: ['sse'],
  },
  openai: {
    provider: 'openai',
    protocol: 'openai',
    apiShape: 'openai-chat-completions',
    baseUrl: requireProviderDefaults('openai').baseUrl,
    model: requireProviderDefaults('openai').defaultModel,
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
    // Default chat; config.apiShape may override to openai-responses for
    // Packy-hosted Grok (cc-switch grokbuild PackyCode uses responses).
    apiShape: 'openai-chat-completions',
    baseUrl: requireProviderDefaults('packycode').baseUrl,
    model: requireProviderDefaults('packycode').defaultModel,
    supportsTools: true,
    supportsParallelToolCalls: false,
    supportsReasoning: true,
    reasoningParam: 'reasoning_effort',
    modelAliases: [
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.6-sol',
      'gpt-5.6-luna',
      'gpt-5.6-terra',
      'grok-4.6',
      'grok-4.5',
      'grok-4.3',
      'grok-4-fast',
    ],
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
    baseUrl: requireProviderDefaults('codex').baseUrl,
    model: requireProviderDefaults('codex').defaultModel,
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
  groq: canonicalOpenAICompatibleProfile('groq'),
  together: canonicalOpenAICompatibleProfile('together'),
  openrouter: canonicalOpenAICompatibleProfile('openrouter'),
  moonshot: canonicalOpenAICompatibleProfile('moonshot'),
  zhipu: canonicalOpenAICompatibleProfile('zhipu'),
  qwen: canonicalOpenAICompatibleProfile('qwen'),
  ollama: canonicalOpenAICompatibleProfile('ollama'),
  lmstudio: canonicalOpenAICompatibleProfile('lmstudio'),
  vllm: canonicalOpenAICompatibleProfile('vllm'),
  llamacpp: canonicalOpenAICompatibleProfile('llamacpp'),
  localai: canonicalOpenAICompatibleProfile('localai'),
  anthropic: canonicalAnthropicProfile('anthropic'),
  claude: canonicalAnthropicProfile('claude'),
  'deepseek-anthropic': canonicalAnthropicProfile('deepseek-anthropic'),
  minimax: canonicalAnthropicProfile('minimax'),
  xai: {
    provider: 'xai',
    protocol: 'openai',
    apiShape: 'openai-chat-completions',
    baseUrl: requireProviderDefaults('xai').baseUrl,
    model: requireProviderDefaults('xai').defaultModel,
    supportsTools: true,
    supportsParallelToolCalls: true,
    supportsReasoning: true,
    reasoningParam: 'reasoning_effort',
    modelAliases: [
      'grok-4.6',
      'grok-4.3',
      'grok-4.5',
      'grok-4.20-multi-agent-0309',
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
    // grok-4.6 = xAI 当前 frontier 默认（2026-09，docs.x.ai/developers/models）；
    // <200k prompt: $2.00/$0.50/$6.00 per 1M（≥200k 翻倍，平铺取 <200k 档近似）。
    pricing: {
      promptTokenCostPer1M: 2.00,
      completionTokenCostPer1M: 6.00,
      cacheHitTokenCostPer1M: 0.50,
    },
  },
};

export function resolveModelProfile(
  provider: string,
  options: ResolveModelProfileOptions = {},
): ModelProfile {
  const canonicalDefaults = resolveProviderDefaults(provider);
  let base = MODEL_PROFILES[provider];
  if (!base && canonicalDefaults) {
    base = openAICompatibleProfile(provider, canonicalDefaults.baseUrl, canonicalDefaults.defaultModel);
  }
  if (!base) {
    const baseUrl = options.baseUrl;
    const model = options.model ?? options.defaultModel;
    if (!baseUrl || !model) {
      throw new Error(
        `Unknown provider '${provider}' requires explicit baseUrl and model configuration`,
      );
    }
    base = openAICompatibleProfile(provider, baseUrl, model);
  }
  const resolved = {
    ...base,
    baseUrl: options.baseUrl ?? base.baseUrl,
    model: options.model ?? base.model,
    apiShape: options.apiShape ?? base.apiShape,
  };
  // 命中模型专属价优先；未命中回退到该 provider 的基本价，**不得返回 undefined**。
  // 原实现是 `base.pricingByModel ? base.pricingByModel[model] : base.pricing`：只要
  // 配了 pricingByModel，未登记的模型名就拿到 undefined ⇒ estimateCost 返回 null ⇒
  // 成本静默归零（2026-10 的 flash 改名事故同型故障，见
  // dsh-dashboards/docs/audits/2026-10-09-billing-cost-audit.md）。
  const pricing = base.pricingByModel?.[resolved.model] ?? base.pricing;
  return {
    ...resolved,
    pricing,
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

function canonicalOpenAICompatibleProfile(provider: string): ModelProfile {
  const defaults = requireProviderDefaults(provider);
  return openAICompatibleProfile(provider, defaults.baseUrl, defaults.defaultModel);
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

function canonicalAnthropicProfile(provider: string): ModelProfile {
  const defaults = requireProviderDefaults(provider);
  return anthropicProfile(provider, defaults.baseUrl, defaults.defaultModel);
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
 * Prices are applied at their off-peak rate by default; when `pricing` has a
 * `peakMultiplier` and `at` falls inside Beijing peak hours, all rates are
 * multiplied by it. `CostEstimate` fields are always USD: CNY prices are
 * converted with `pricing.cnyPerUsd` (or {@link DEFAULT_CNY_PER_USD}).
 * Returns null when pricing data is unavailable.
 */
export function calculateCost(
  usage: { promptTokens: number; completionTokens: number; cacheHitTokens?: number; cacheMissTokens?: number },
  pricing: ModelPricing,
  at: Date = new Date(),
): CostEstimate {
  const peak = pricing.peakMultiplier && pricing.peakMultiplier !== 1 && billingPeriodAt(at) === 'peak'
    ? pricing.peakMultiplier
    : 1;
  const promptPrice = pricing.promptTokenCostPer1M * peak;
  const completionPrice = pricing.completionTokenCostPer1M * peak;
  const cacheHitPrice = pricing.cacheHitTokenCostPer1M * peak;
  const cacheHitTokens = usage.cacheHitTokens ?? 0;
  const cacheMissTokens = usage.cacheMissTokens ?? 0;
  const hasCacheBreakdown = cacheHitTokens > 0 || cacheMissTokens > 0;
  const promptTokens = pricing.promptTokensIncludeCacheHits
    ? Math.max(0, hasCacheBreakdown ? cacheMissTokens : usage.promptTokens - cacheHitTokens)
    : usage.promptTokens;
  const promptCost = (promptTokens / 1_000_000) * promptPrice;
  const completionCost = (usage.completionTokens / 1_000_000) * completionPrice;
  const cacheHitCost = (cacheHitTokens / 1_000_000) * cacheHitPrice;
  const cacheSavings = (cacheHitTokens / 1_000_000) * (promptPrice - cacheHitPrice);
  const usdRate = pricing.currency === 'cny' ? (pricing.cnyPerUsd ?? DEFAULT_CNY_PER_USD) : 1;
  return {
    totalCostUsd: (promptCost + completionCost + cacheHitCost) / usdRate,
    promptCostUsd: promptCost / usdRate,
    completionCostUsd: completionCost / usdRate,
    cacheHitCostUsd: cacheHitCost / usdRate,
    cacheSavingsUsd: cacheSavings / usdRate,
  };
}

/**
 * Calculate estimated cost from token usage and a model profile.
 * Returns null when the profile has no pricing data.
 */
export function estimateCost(
  usage: { promptTokens: number; completionTokens: number; cacheHitTokens?: number; cacheMissTokens?: number },
  profile: ModelProfile,
  at: Date = new Date(),
): CostEstimate | null {
  if (!profile.pricing) return null;
  return calculateCost(usage, profile.pricing, at);
}
