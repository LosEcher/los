export interface ModelSettings {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
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
  };
  return hasModelSettings(settings) ? settings : undefined;
}

export function buildOpenAIModelSettings(settings: ModelSettings | undefined): Record<string, unknown> {
  if (!settings) return {};
  return compactSettings({
    temperature: settings.temperature,
    top_p: settings.topP,
    max_tokens: settings.maxTokens,
    presence_penalty: settings.presencePenalty,
    frequency_penalty: settings.frequencyPenalty,
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
