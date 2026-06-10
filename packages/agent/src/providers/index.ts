/**
 * @los/agent/providers — Multi-provider LLM abstraction.
 *
 * Supported protocols:
 *   - OpenAI-compatible (DeepSeek, OpenAI, Groq, Together, Ollama, vLLM...)
 *   - Anthropic Messages (Claude, MiniMax)
 *
 * DeepSeek-specific adaptations:
 *   - R1 reasoning_content extraction
 *   - Tool call JSON repair (malformed args from DeepSeek)
 *
 * Inspired by:
 *   - pi's @earendil-works/pi-ai (streamAnthropic, streamSimpleAnthropic)
 *   - lsclaw's callDeepSeek (prefix-cache, repairDeepSeekToolCall, extractReasoningContent)
 *   - lsclaw's callAnthropic (MiniMax via Anthropic Messages)
 */

import { getConfig } from '@los/infra/config';
import { getLogger } from '@los/infra/logger';
import { resolveModelProfile, type ApiShape, type ModelProfile } from '../model-profiles.js';
import {
  buildOpenAIModelSettings,
} from '../model-settings.js';
import { buildOpenAICompatUrl, drainSseBuffer, repairJson, repairToolCallArguments, type RepairResult } from './openai-utils.js';
import { createAnthropicProvider } from './anthropic.js';
import { createOpenAIResponsesProvider } from './responses.js';
import type {
  ChatOptions,
  CreateProviderOptions,
  Message,
  Provider,
  ProviderDelta,
  ProviderModelInfo,
  ProviderResponse,
  ToolCall,
  ToolDef,
} from './types.js';

const log = getLogger('agent');

export type {
  ChatOptions,
  CreateProviderOptions,
  Message,
  Provider,
  ProviderDelta,
  ProviderModelInfo,
  ProviderResponse,
  ToolCall,
  ToolDef,
} from './types.js';

// Re-export shared utilities used by external consumers
export { buildOpenAICompatUrl } from './openai-utils.js';
export { convertMessagesToResponsesInput, readResponsesStreamResponse } from './responses.js';

// ── Provider Factory ─────────────────────────────────────

function getProviderConfig(name: string) {
  const config = getConfig();
  const p = config.providers[name];
  if (!p || !p.enabled) {
    throw new Error(`Provider '${name}' not configured. Set ${name.toUpperCase()}_API_KEY or add to ~/.los/accounts/`);
  }
  if (!p.apiKey) {
    throw new Error(`Provider '${name}' has no API key.`);
  }
  return p;
}



// ── OpenAI-compatible Provider (DeepSeek, OpenAI, Groq...) ─

interface OpenAIConfig {
  name: string;
  apiKey: string;
  profile: ModelProfile;
}

function createOpenAICompatProvider(cfg: OpenAIConfig): Provider {
  const { name, apiKey, profile } = cfg;
  const { baseUrl, model } = profile;

  return {
    name,
    profile,

    async chat(messages: Message[], tools?: ToolDef[], options: ChatOptions = {}): Promise<ProviderResponse> {
      const body: Record<string, unknown> = {
        model,
        messages,
        stream: Boolean(options.onDelta),
        ...buildOpenAIModelSettings(options.modelSettings),
      };
      if (options.onDelta) {
        body.stream_options = { include_usage: true };
      }

      if (tools?.length) {
        body.tools = tools;
        body.tool_choice = 'auto';
      }

      const chatUrl = buildOpenAICompatUrl(baseUrl, '/chat/completions');

      const res = await fetch(chatUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: options.signal,
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`${name} API error ${res.status}: ${err.slice(0, 300)}`);
      }

      if (options.onDelta) {
        return await readOpenAIStreamResponse(res, model, name, options.onDelta);
      }

      const data = await res.json() as any;
      const choice = data.choices?.[0];
      const msg = choice?.message;

      // R1 reasoning_content extraction
      const reasoningContent = msg?.reasoning_content
        ?? choice?.reasoning_content
        ?? data?.reasoning_content
        ?? undefined;

      // Tool calls with repair
      let toolCalls: ToolCall[] = msg?.tool_calls ?? [];
      if (toolCalls.length > 0) {
        toolCalls = toolCalls.map((tc: ToolCall) => {
          try {
            JSON.parse(tc.function.arguments);
            return tc;
          } catch {
            const { result, steps } = repairJson(tc.function.arguments);
            if (result) {
              log.debug(`[${name}] Repaired tool call args for ${tc.function.name} (steps: ${steps.join(',')})`);
              return {
                ...tc,
                function: { ...tc.function, arguments: result },
                _repair: { repaired: true, originalArguments: tc.function.arguments, repairSteps: steps },
              } as ToolCall & { _repair?: RepairResult };
            }
            log.warn(`[${name}] Could not repair tool call args for ${tc.function.name}`);
            return tc;
          }
        });
      }

      return {
        text: msg?.content ?? '',
        toolCalls,
        reasoningContent,
        usage: {
          promptTokens: data.usage?.prompt_tokens ?? data.usage?.input_tokens ?? 0,
          completionTokens: data.usage?.completion_tokens ?? data.usage?.output_tokens ?? 0,
          cacheHitTokens: data.usage?.prompt_cache_hit_tokens ?? data.usage?.cache_read_input_tokens ?? 0,
          cacheMissTokens: data.usage?.prompt_cache_miss_tokens ?? data.usage?.cache_creation_input_tokens ?? 0,
          totalTokens: data.usage?.total_tokens ?? undefined,
        },
        model: data.model ?? model,
      };
    },

    async listModels(options: { signal?: AbortSignal } = {}): Promise<ProviderModelInfo[]> {
      const res = await fetch(
        buildOpenAICompatUrl(baseUrl, '/models'),
        {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        signal: options.signal,
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`${name} models API error ${res.status}: ${err.slice(0, 300)}`);
      }

      const data = await res.json() as any;
      const items: ProviderModelInfo[] = Array.isArray(data?.data)
        ? data.data
            .map((item: any): ProviderModelInfo | null => {
              const id = typeof item?.id === 'string' ? item.id.trim() : '';
              if (!id) return null;
              return {
                id,
                object: typeof item?.object === 'string' ? item.object : undefined,
                ownedBy: typeof item?.owned_by === 'string' ? item.owned_by : undefined,
                raw: item && typeof item === 'object' ? item as Record<string, unknown> : undefined,
              };
            })
            .filter((item: ProviderModelInfo | null): item is ProviderModelInfo => Boolean(item))
        : [];
      return items
        .sort((a: ProviderModelInfo, b: ProviderModelInfo) => a.id.localeCompare(b.id));
    },
  };
}

// ── OpenAI stream reader (internal) ──────────────────────

async function readOpenAIStreamResponse(
  res: Response,
  fallbackModel: string,
  providerName: string,
  onDelta: (delta: ProviderDelta) => void | Promise<void>,
): Promise<ProviderResponse> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error(`${providerName} API returned no stream body`);

  const decoder = new TextDecoder();
  const toolCalls = new Map<number, ToolCall>();
  let buffer = '';
  let text = '';
  let reasoningContent = '';
  let responseModel = fallbackModel;
  let usage: ProviderResponse['usage'] = { promptTokens: 0, completionTokens: 0 };

  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      const parsed = drainSseBuffer(buffer);
      buffer = parsed.rest;
      for (const payload of parsed.payloads) {
        if (payload === '[DONE]') continue;
        const chunk = JSON.parse(payload);
        responseModel = chunk.model ?? responseModel;
        usage = normalizeOpenAIUsage(chunk.usage, usage);
        const delta = chunk.choices?.[0]?.delta ?? {};
        const textDelta = delta.content ?? '';
        const reasoningDelta = delta.reasoning_content ?? '';
        if (textDelta) {
          text += textDelta;
          await onDelta({ textDelta, model: responseModel });
        }
        if (reasoningDelta) {
          reasoningContent += reasoningDelta;
          await onDelta({ reasoningDelta, model: responseModel });
        }
        mergeToolCallDeltas(toolCalls, delta.tool_calls ?? []);
      }
    }
    if (done) break;
  }

  return {
    text,
    toolCalls: [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, toolCall]) => repairToolCallArguments(toolCall, providerName)),
    reasoningContent: reasoningContent || undefined,
    usage,
    model: responseModel,
  };
}

function mergeToolCallDeltas(toolCalls: Map<number, ToolCall>, deltas: any[]): void {
  for (const delta of deltas) {
    const index = Number.isInteger(delta.index) ? delta.index : toolCalls.size;
    const existing = toolCalls.get(index) ?? {
      id: delta.id ?? `call_${index}`,
      type: 'function' as const,
      function: { name: '', arguments: '' },
    };
    toolCalls.set(index, {
      ...existing,
      id: delta.id ?? existing.id,
      type: 'function',
      function: {
        name: existing.function.name + (delta.function?.name ?? ''),
        arguments: existing.function.arguments + (delta.function?.arguments ?? ''),
      },
    });
  }
}

function normalizeOpenAIUsage(raw: any, fallback: ProviderResponse['usage']): ProviderResponse['usage'] {
  if (!raw) return fallback;
  return {
    promptTokens: raw.prompt_tokens ?? raw.input_tokens ?? fallback.promptTokens,
    completionTokens: raw.completion_tokens ?? raw.output_tokens ?? fallback.completionTokens,
    cacheHitTokens: raw.prompt_cache_hit_tokens ?? raw.cache_read_input_tokens ?? fallback.cacheHitTokens ?? 0,
    cacheMissTokens: raw.prompt_cache_miss_tokens ?? raw.cache_creation_input_tokens ?? fallback.cacheMissTokens ?? 0,
    totalTokens: raw.total_tokens ?? fallback.totalTokens,
  };
}



// ── Provider Registry ────────────────────────────────────

export function createProvider(name?: string, options: CreateProviderOptions = {}): Provider {
  const config = getConfig();
  const providerName = name ?? config.agent.defaultProvider;

  const p = getProviderConfig(providerName);
  const apiShapeOverride = (options.apiShape ?? (p as Record<string, unknown>).apiShape) as ApiShape | undefined;
  const profile = resolveModelProfile(providerName, {
    baseUrl: options.baseUrl ?? p.baseUrl,
    model: options.model ?? p.model,
    defaultModel: config.agent.defaultModel,
    apiShape: apiShapeOverride,
  });

  if (profile.protocol === 'anthropic') {
    return createAnthropicProvider({
      name: providerName,
      apiKey: p.apiKey!,
      profile,
    });
  }

  if (profile.apiShape === 'openai-responses') {
    return createOpenAIResponsesProvider({
      name: providerName,
      apiKey: p.apiKey!,
      profile,
    });
  }

  return createOpenAICompatProvider({
    name: providerName,
    apiKey: p.apiKey!,
    profile,
  });
}

// ── Named constructors (backward compat) ─────────────────

export function createDeepSeekProvider(): Provider {
  const p = getProviderConfig('deepseek');
  const profile = resolveModelProfile('deepseek', {
    baseUrl: p.baseUrl,
    model: p.model,
    defaultModel: getConfig().agent.defaultModel,
  });
  return createOpenAICompatProvider({
    name: 'deepseek',
    apiKey: p.apiKey!,
    profile,
  });
}

export function createOpenAIProvider(): Provider | null {
  try {
    const p = getProviderConfig('openai');
    const profile = resolveModelProfile('openai', {
      baseUrl: p.baseUrl,
      model: p.model,
      defaultModel: getConfig().agent.defaultModel,
    });
    return createOpenAICompatProvider({
      name: 'openai',
      apiKey: p.apiKey!,
      profile,
    });
  } catch { return null; }
}
