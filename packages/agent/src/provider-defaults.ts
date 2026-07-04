/**
 * @los/agent/provider-defaults — Single source of truth for provider URLs
 * and default models.
 *
 * Provider adapters, discovery scanners, and model-profiles each had their
 * own copies of the same URLs and model names. This module consolidates them
 * so a provider's URL changes in exactly one place.
 *
 * AP8 fix: hardcoded defaults now live here, not duplicated across 3+ files.
 */

export interface ProviderDefaults {
  /** Canonical API base URL. */
  baseUrl: string;
  /** Default model when none is specified. */
  defaultModel: string;
}

/** Canonical provider defaults. One entry per known provider. */
export const PROVIDER_DEFAULTS: Record<string, ProviderDefaults> = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-v4-flash',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.5',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-20250514',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.1-70b-versatile',
  },
  together: {
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
  },
  moonshot: {
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
  },
  ollama: {
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'llama3.1',
  },
  lmstudio: {
    baseUrl: 'http://127.0.0.1:1234/v1',
    defaultModel: '(auto)',
  },
  vllm: {
    baseUrl: 'http://127.0.0.1:8000/v1',
    defaultModel: '(auto)',
  },
};

/** Resolve defaults for a provider, with a fallback. */
export function resolveProviderDefaults(
  provider: string,
): ProviderDefaults {
  return PROVIDER_DEFAULTS[provider] ?? {
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
  };
}
