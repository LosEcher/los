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
import { resolveModelProfile, type ModelProfile } from '../model-profiles.js';

const log = getLogger('agent');

// ── Types ───────────────────────────────────────────────

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ProviderResponse {
  text: string;
  toolCalls: ToolCall[];
  reasoningContent?: string;    // DeepSeek R1 / Claude thinking
  usage: {
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
    totalTokens?: number;
  };
  model: string;
}

export interface ChatOptions {
  signal?: AbortSignal;
}

export interface Provider {
  name: string;
  profile: ModelProfile;
  chat(messages: Message[], tools?: ToolDef[], options?: ChatOptions): Promise<ProviderResponse>;
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

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

// ── Tool Call JSON Repair (DeepSeek) ────────────────────

/**
 * Non-destructive JSON repair for DeepSeek's known malformed tool-call arguments.
 * Handles: markdown fences, trailing commas, unbalanced braces, unescaped control chars.
 *
 * From lsclaw's `repairDeepSeekToolCall()` in provider-router-adapters.mjs:946-1033
 */
function repairJson(content: string): string | null {
  let text = content.trim();

  // Strip markdown fences
  text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');

  if (!text) return null;

  // Try direct parse
  try { JSON.parse(text); return text; } catch {}

  // Fix trailing commas: ,} → }  ,] → ]
  let fixed = text.replace(/,(\s*[}\]])/g, '$1');

  // Balance braces
  let depth = 0;
  for (const ch of fixed) {
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;
  }
  while (depth > 0) { fixed += '}'; depth--; }
  while (depth < 0) { fixed = '{' + fixed; depth++; }

  // Fix unquoted property names like {name: "x"} → {"name": "x"}
  fixed = fixed.replace(/(\{|\,)\s*([a-zA-Z_$][\w$]*)\s*:/g, '$1"$2":');

  try { JSON.parse(fixed); return fixed; } catch {}

  return null; // Give up — caller will surface original error
}

// ── OpenAI-compatible Provider (DeepSeek, OpenAI, Groq...) ─

interface OpenAIConfig {
  name: string;
  apiKey: string;
  profile: ModelProfile;
}

export interface CreateProviderOptions {
  model?: string;
  baseUrl?: string;
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
        stream: false,
      };

      if (tools?.length) {
        body.tools = tools;
        body.tool_choice = 'auto';
      }

      const chatUrl = baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions`
        : baseUrl.endsWith('/') ? `${baseUrl}chat/completions`
        : `${baseUrl}/v1/chat/completions`;

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
            const repaired = repairJson(tc.function.arguments);
            if (repaired) {
              log.debug(`[${name}] Repaired tool call args for ${tc.function.name}`);
              return { ...tc, function: { ...tc.function, arguments: repaired } };
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
  };
}

// ── Anthropic Messages Provider (Claude, MiniMax) ────────

interface AnthropicConfig {
  name: string;
  apiKey: string;
  profile: ModelProfile;
}

/**
 * Anthropic Messages API adapter.
 * MiniMax speaks this protocol natively at api.minimaxi.com/anthropic.
 * Claude uses api.anthropic.com/v1/messages.
 *
 * From lsclaw's `callAnthropic()` and pi's `streamAnthropic()`.
 */
function createAnthropicProvider(cfg: AnthropicConfig): Provider {
  const { name, apiKey, profile } = cfg;
  const { baseUrl, model } = profile;
  const API_VERSION = '2023-06-01';
  const MAX_TOKENS = 8192;

  return {
    name,
    profile,

    async chat(messages: Message[], tools?: ToolDef[], options: ChatOptions = {}): Promise<ProviderResponse> {
      // Convert OpenAI-format messages → Anthropic format
      const systemMessages: string[] = [];
      const anthropicMessages: any[] = [];

      for (const msg of messages) {
        if (msg.role === 'system') {
          systemMessages.push(msg.content);
        } else if (msg.role === 'tool') {
          anthropicMessages.push({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id!, content: msg.content }],
          });
        } else if (msg.role === 'assistant' && msg.tool_calls?.length) {
          anthropicMessages.push({
            role: 'assistant',
            content: msg.tool_calls.map((tc: ToolCall) => ({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: JSON.parse(tc.function.arguments),
            })),
          });
        } else {
          const content = msg.content || '(empty)';
          const existing = anthropicMessages[anthropicMessages.length - 1];
          if (existing?.role === msg.role) {
            // Merge consecutive same-role messages
            if (typeof existing.content === 'string') {
              existing.content += '\n' + content;
            } else {
              existing.content.push({ type: 'text', text: content });
            }
          } else {
            anthropicMessages.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content });
          }
        }
      }

      // Build request
      const body: Record<string, unknown> = {
        model,
        max_tokens: MAX_TOKENS,
        messages: anthropicMessages,
      };

      if (systemMessages.length > 0) {
        body.system = systemMessages.join('\n');
      }

      if (tools?.length) {
        body.tools = tools.map(t => ({
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters,
        }));
      }

      const messagesUrl = baseUrl.endsWith('/v1/messages') ? baseUrl
        : baseUrl.endsWith('/') ? `${baseUrl}v1/messages`
        : `${baseUrl}/v1/messages`;

      const res = await fetch(messagesUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify(body),
        signal: options.signal,
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`${name} API error ${res.status}: ${err.slice(0, 300)}`);
      }

      const data = await res.json() as any;

      // Parse response back to OpenAI-compatible format
      let text = '';
      const toolCalls: ToolCall[] = [];
      let reasoningContent: string | undefined;

      for (const block of data.content ?? []) {
        if (block.type === 'text') {
          text += (text ? '\n' : '') + block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        } else if (block.type === 'thinking') {
          reasoningContent = (reasoningContent ?? '') + block.thinking;
        }
      }

      return {
        text,
        toolCalls,
        reasoningContent,
        usage: {
          promptTokens: data.usage?.input_tokens ?? 0,
          completionTokens: data.usage?.output_tokens ?? 0,
          cacheHitTokens: data.usage?.cache_read_input_tokens ?? 0,
          cacheMissTokens: data.usage?.cache_creation_input_tokens ?? 0,
          totalTokens: data.usage?.input_tokens != null && data.usage?.output_tokens != null
            ? (data.usage.input_tokens + data.usage.output_tokens)
            : undefined,
        },
        model: data.model ?? model,
      };
    },
  };
}

// ── Provider Registry ────────────────────────────────────

export function createProvider(name?: string, options: CreateProviderOptions = {}): Provider {
  const config = getConfig();
  const providerName = name ?? config.agent.defaultProvider;

  const p = getProviderConfig(providerName);
  const profile = resolveModelProfile(providerName, {
    baseUrl: options.baseUrl ?? p.baseUrl,
    model: options.model ?? p.model,
    defaultModel: config.agent.defaultModel,
  });

  if (profile.protocol === 'anthropic') {
    return createAnthropicProvider({
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
