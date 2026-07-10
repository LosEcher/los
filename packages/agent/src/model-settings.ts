export interface ModelSettings {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  /** xAI Grok / OpenAI reasoning effort. 'none' disables reasoning on models that support it. */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max' | 'xhigh' | 'none';
  /** Provider thinking mode. Currently emitted for DeepSeek OpenAI-compatible requests. */
  thinking?: 'enabled' | 'disabled';
}

export function normalizeModelSettings(value: unknown): ModelSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const settings: ModelSettings = {
    temperature: normalizeNumber(record.temperature, 0, 2),
    topP: normalizeNumber(record.topP ?? record.top_p, 0, 1),
    maxTokens: normalizeInteger(record.maxTokens ?? record.max_tokens, 1, 200_000),
    presencePenalty: normalizeNumber(record.presencePenalty ?? record.presence_penalty, -2, 2),
    frequencyPenalty: normalizeNumber(record.frequencyPenalty ?? record.frequency_penalty, -2, 2),
    reasoningEffort: normalizeReasoningEffort(record.reasoningEffort ?? record.reasoning_effort),
    thinking: normalizeThinkingMode(record.thinking ?? record.thinkingMode ?? record.thinking_mode),
  };
  return hasModelSettings(settings)
    ? compactSettings(settings as Record<string, unknown>) as ModelSettings
    : undefined;
}

export function buildOpenAIModelSettings(
  settings: ModelSettings | undefined,
  provider?: string,
): Record<string, unknown> {
  if (!settings) return {};
  const isDeepSeek = provider?.toLowerCase() === 'deepseek';
  const thinking = isDeepSeek
    ? settings.thinking ?? (settings.reasoningEffort === 'none' ? 'disabled' : undefined)
    : undefined;
  const reasoningEffort = isDeepSeek
    ? normalizeDeepSeekReasoningEffort(settings.reasoningEffort)
    : settings.reasoningEffort;
  return compactSettings({
    temperature: settings.temperature,
    top_p: settings.topP,
    max_tokens: settings.maxTokens,
    presence_penalty: settings.presencePenalty,
    frequency_penalty: settings.frequencyPenalty,
    reasoning_effort: thinking === 'disabled' ? undefined : reasoningEffort,
    thinking: thinking ? { type: thinking } : undefined,
  });
}

export function buildAnthropicModelSettings(
  settings: ModelSettings | undefined,
  fallbackMaxTokens: number,
): Record<string, unknown> {
  return compactSettings({
    max_tokens: settings?.maxTokens ?? fallbackMaxTokens,
    temperature: settings?.temperature,
    top_p: settings?.topP,
  });
}

function hasModelSettings(settings: ModelSettings): boolean {
  return Object.values(settings).some(value => value !== undefined);
}

function compactSettings(settings: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined));
}

function normalizeNumber(value: unknown, min: number, max: number): number | undefined {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(number)) return undefined;
  return Math.min(max, Math.max(min, number));
}

function normalizeInteger(value: unknown, min: number, max: number): number | undefined {
  const number = normalizeNumber(value, min, max);
  return number === undefined ? undefined : Math.floor(number);
}

function normalizeReasoningEffort(value: unknown): ModelSettings['reasoningEffort'] {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return ['low', 'medium', 'high', 'max', 'xhigh', 'none'].includes(normalized)
    ? normalized as ModelSettings['reasoningEffort']
    : undefined;
}

function normalizeThinkingMode(value: unknown): ModelSettings['thinking'] {
  if (typeof value === 'boolean') return value ? 'enabled' : 'disabled';
  const candidate = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).type
    : value;
  if (typeof candidate !== 'string') return undefined;
  const normalized = candidate.trim().toLowerCase();
  return normalized === 'enabled' || normalized === 'disabled' ? normalized : undefined;
}

function normalizeDeepSeekReasoningEffort(
  value: ModelSettings['reasoningEffort'],
): 'high' | 'max' | undefined {
  if (value === 'low' || value === 'medium' || value === 'high') return 'high';
  if (value === 'max' || value === 'xhigh') return 'max';
  return undefined;
}
