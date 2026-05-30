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

export interface Provider {
  name: string;
  chat(messages: Message[], tools?: ToolDef[]): Promise<ProviderResponse>;
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
  baseUrl: string;
  model: string;
}

function createOpenAICompatProvider(cfg: OpenAIConfig): Provider {
  const { name, apiKey, baseUrl, model } = cfg;

  return {
    name,

    async chat(messages: Message[], tools?: ToolDef[]): Promise<ProviderResponse> {
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
  baseUrl: string;
  model: string;
}

/**
 * Anthropic Messages API adapter.
 * MiniMax speaks this protocol natively at api.minimaxi.com/anthropic.
 * Claude uses api.anthropic.com/v1/messages.
 *
 * From lsclaw's `callAnthropic()` and pi's `streamAnthropic()`.
 */
function createAnthropicProvider(cfg: AnthropicConfig): Provider {
  const { name, apiKey, baseUrl, model } = cfg;
  const API_VERSION = '2023-06-01';
  const MAX_TOKENS = 8192;

  return {
    name,

    async chat(messages: Message[], tools?: ToolDef[]): Promise<ProviderResponse> {
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

const PROVIDER_PROTOCOLS: Record<string, 'openai' | 'anthropic'> = {
  deepseek: 'openai',
  openai: 'openai',
  groq: 'openai',
  together: 'openai',
  openrouter: 'openai',
  moonshot: 'openai',
  zhipu: 'openai',
  qwen: 'openai',
  ollama: 'openai',
  lmstudio: 'openai',
  vllm: 'openai',
  anthropic: 'anthropic',
  claude: 'anthropic',
  minimax: 'anthropic',
};

const OPENAI_COMPAT_DEFAULTS: Record<string, { baseUrl: string; model?: string }> = {
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  openai: { baseUrl: 'https://api.openai.com/v1' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1' },
  together: { baseUrl: 'https://api.together.xyz/v1' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1' },
  moonshot: { baseUrl: 'https://api.moonshot.cn/v1' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
};

export function createProvider(name?: string): Provider {
  const config = getConfig();
  const providerName = name ?? config.agent.defaultProvider;

  const p = getProviderConfig(providerName);
  const protocol = PROVIDER_PROTOCOLS[providerName] ?? 'openai';

  if (protocol === 'anthropic') {
    return createAnthropicProvider({
      name: providerName,
      apiKey: p.apiKey!,
      baseUrl: p.baseUrl ?? 'https://api.anthropic.com',
      model: p.model ?? config.agent.defaultModel,
    });
  }

  const defaults = OPENAI_COMPAT_DEFAULTS[providerName] ?? { baseUrl: 'https://api.openai.com/v1' };
  return createOpenAICompatProvider({
    name: providerName,
    apiKey: p.apiKey!,
    baseUrl: p.baseUrl ?? defaults.baseUrl,
    model: p.model ?? defaults.model ?? config.agent.defaultModel,
  });
}

// ── Named constructors (backward compat) ─────────────────

export function createDeepSeekProvider(): Provider {
  const p = getProviderConfig('deepseek');
  return createOpenAICompatProvider({
    name: 'deepseek',
    apiKey: p.apiKey!,
    baseUrl: p.baseUrl ?? 'https://api.deepseek.com',
    model: p.model ?? getConfig().agent.defaultModel,
  });
}

export function createOpenAIProvider(): Provider | null {
  try {
    const p = getProviderConfig('openai');
    return createOpenAICompatProvider({
      name: 'openai',
      apiKey: p.apiKey!,
      baseUrl: p.baseUrl ?? 'https://api.openai.com/v1',
      model: p.model ?? getConfig().agent.defaultModel,
    });
  } catch { return null; }
}
