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
import { AgentError } from '../error-base.js';
import { resolveModelProfile, type ApiShape, type ModelProfile } from '../model-profiles.js';
import {
  buildOpenAIModelSettings,
} from '../model-settings.js';
import { buildOpenAICompatUrl, drainSseBuffer, repairJson, repairToolCallArguments, type RepairResult } from './openai-utils.js';
import { mergeToolCallDeltas, mergeSplitToolCalls } from './delta-repair.js';
import { createAnthropicProvider } from './anthropic.js';
import { createOpenAIResponsesProvider } from './responses.js';
import { recordProviderCall } from './telemetry.js';
import { incrementRepairCounter } from './repair-telemetry.js';

// Proxy support — when HTTPS_PROXY or HTTP_PROXY is set, route all outbound
// provider calls through the proxy. Required for api.x.ai on machines where
// direct TLS is blocked and a local proxy (e.g. Surge) is the only path.
// Node's internal undici does NOT automatically read these env vars for fetch(),
// so we set a global dispatcher that tunnels through the proxy.
let _proxyInit = false;
export function initGlobalProxy(): void {
  if (_proxyInit) return;
  _proxyInit = true;
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!proxy) return;

  // Dynamic import in ESM context — tsx-transpiled require('undici')
  // may fail in pnpm workspace symlink chains, but import() always works.
  import('undici').then(
    ({ ProxyAgent, setGlobalDispatcher }) => {
      setGlobalDispatcher(new ProxyAgent({ uri: proxy }));
      log.info(`Proxy: outbound provider calls routed through ${proxy}`);
    },
    () => {
      log.warn(`Proxy: HTTPS_PROXY=${proxy} is set but undici unavailable`);
    },
  );
}
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
import { normalizeFinishReason } from './types.js';

const log = getLogger('agent');

// ── Provider diagnostics ────────────────────────────────
// Set LOS_DEBUG_PROVIDER=true to log raw SSE tool-call deltas at info level.
// This surfaces provider-specific streaming quirks without code changes.
const DEBUG_PROVIDER = process.env.LOS_DEBUG_PROVIDER === 'true';

export function diag(traceId: string | undefined, msg: string, detail?: Record<string, unknown>) {
  if (!DEBUG_PROVIDER) return;
  log.info(msg, { traceId, ...detail });
}

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

export function getProviderConfig(name: string) {
  const config = getConfig();
  const p = config.providers[name];
  if (!p || !p.enabled) {
    throw new Error(`Provider '${name}' not configured. Set ${name.toUpperCase()}_API_KEY or add to ~/.los/accounts/`);
  }

  if (!p.apiKey) {
    // OAuth credentials are resolved lazily by the async transport immediately
    // before each request, so single-use refresh tokens can be rotated safely.
    if ((p as Record<string, unknown>).authMode === 'oauth') {
      if (name === 'xai') return p;
      throw new Error(`Provider '${name}' has no supported OAuth credential resolver.`);
    }
    throw new Error(`Provider '${name}' has no API key.`);
  }
  return p;
}



// ── OpenAI-compatible Provider (DeepSeek, OpenAI, Groq...) ─

interface OpenAIConfig {
  name: string;
  apiKey?: string;
  profile: ModelProfile;
  traceId?: string;
  credentialResolver?: () => Promise<{ apiKey: string; baseUrl: string }>;
}

export function createOpenAICompatProvider(cfg: OpenAIConfig): Provider {
  initGlobalProxy();
  const { name, apiKey, profile, traceId } = cfg;
  const { baseUrl: configuredBaseUrl, model } = profile;

  const resolveCredential = async (): Promise<{ apiKey: string; baseUrl: string }> => {
    if (cfg.credentialResolver) return cfg.credentialResolver();
    if (!apiKey) throw new Error(`Provider '${name}' has no API credential.`);
    return { apiKey, baseUrl: configuredBaseUrl };
  };

  return {
    name,
    profile,

    async chat(messages: Message[], tools?: ToolDef[], options: ChatOptions = {}): Promise<ProviderResponse> {
      const body: Record<string, unknown> = {
        model,
        messages,
        stream: Boolean(options.onDelta),
        ...buildOpenAIModelSettings(options.modelSettings, profile.provider),
      };
      if (options.onDelta) {
        body.stream_options = { include_usage: true };
      }

      if (tools?.length) {
        body.tools = tools;
        body.tool_choice = 'auto';
        if (!profile.supportsParallelToolCalls) {
          body.parallel_tool_calls = false;
        }
      }

      const credential = await resolveCredential();
      const chatUrl = buildOpenAICompatUrl(credential.baseUrl, '/chat/completions');
      const bodyStr = JSON.stringify(body);
      const fetchStart = Date.now();

      let res: Response;
      try {
        res = await fetch(chatUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${credential.apiKey}`,
          },
          body: bodyStr,
          signal: options.signal,
        });
      } catch (err: any) {
        recordProviderCall({
          traceId: options.traceId ?? traceId ?? '',
          sessionId: options.sessionId,
          provider: name, model, endpoint: '/chat/completions', method: 'POST',
          stream: Boolean(options.onDelta), requestPayloadSize: bodyStr.length,
          status: 0, durationMs: Date.now() - fetchStart,
          errorCode: 'PROVIDER_NETWORK', errorMessage: err?.message?.slice(0, 500),
        }).catch(() => {});
        throw err;
      }
      recordProviderCall({
        traceId: options.traceId ?? traceId ?? '',
        sessionId: options.sessionId,
        provider: name, model, endpoint: '/chat/completions', method: 'POST',
        stream: Boolean(options.onDelta), requestPayloadSize: bodyStr.length,
        status: res.status, durationMs: Date.now() - fetchStart,
        ...(res.ok ? {} : { errorCode: 'PROVIDER_HTTP_ERROR', errorMessage: `HTTP ${res.status}` }),
      }).catch(() => {});

      if (!res.ok) {
        const err = await res.text();
        throw AgentError.fromProviderResponse('PROVIDER_HTTP_ERROR', name, model, res.status, err, res.headers);
      }

      if (options.onDelta) {
        return await readOpenAIStreamResponse(res, model, name, options.onDelta, options.traceId ?? traceId);
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

      // Extract finish_reason from the first choice or top-level. OpenAI Chat
      // Completions already speaks the canonical vocabulary; normalize is a
      // null/empty guard + keeps the contract uniform across adapters.
      const rawFinishReason: string | undefined = choice?.finish_reason
        ?? data?.choices?.[0]?.finish_reason
        ?? undefined;

      return {
        text: msg?.content ?? '',
        toolCalls,
        reasoningContent,
        finishReason: normalizeFinishReason(rawFinishReason, 'openai'),
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
      const credential = await resolveCredential();
      const modelsUrl = buildOpenAICompatUrl(credential.baseUrl, '/models');
      const fetchStart = Date.now();

      let res: Response;
      try {
        res = await fetch(modelsUrl, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${credential.apiKey}`,
          },
          signal: options.signal,
        });
      } catch (err: any) {
        recordProviderCall({
          traceId: traceId ?? '',
          sessionId: undefined,
          provider: name, model, endpoint: '/models', method: 'GET',
          stream: false, requestPayloadSize: 0,
          status: 0, durationMs: Date.now() - fetchStart,
          errorCode: 'PROVIDER_NETWORK', errorMessage: err?.message?.slice(0, 500),
        }).catch(() => {});
        throw err;
      }
      recordProviderCall({
        traceId: traceId ?? '',
        sessionId: undefined,
        provider: name, model, endpoint: '/models', method: 'GET',
        stream: false, requestPayloadSize: 0,
        status: res.status, durationMs: Date.now() - fetchStart,
        ...(res.ok ? {} : { errorCode: 'PROVIDER_HTTP_ERROR', errorMessage: `HTTP ${res.status}` }),
      }).catch(() => {});

      if (!res.ok) {
        const err = await res.text();
        throw AgentError.fromProviderResponse('PROVIDER_HTTP_ERROR', name, model, res.status, err, res.headers);
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
  traceId?: string,
): Promise<ProviderResponse> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error(`${providerName} API returned no stream body`);

  const decoder = new TextDecoder();
  const toolCalls = new Map<number, ToolCall>();
  let buffer = '';
  let text = '';
  let reasoningContent = '';
  let responseModel = fallbackModel;
  let finishReason: string | undefined;
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
        // Capture finish_reason from the terminating chunk (may be null on intermediate deltas)
        const chunkFinishReason: string | undefined = chunk.choices?.[0]?.finish_reason ?? undefined;
        if (chunkFinishReason) finishReason = normalizeFinishReason(chunkFinishReason, 'openai');
        // Diagnostic: log raw tool-call deltas when LOS_DEBUG_PROVIDER is set
        if (delta.tool_calls?.length) {
          diag(traceId, `[${providerName}] raw tool_call deltas`, {
            deltas: delta.tool_calls,
          } as Record<string, unknown>);
        }
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

  const finalToolCalls = [...toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, toolCall]) => repairToolCallArguments(toolCall, providerName));

  // Post-processing: repair split tool calls where a provider/streaming quirk
  // separated the function name and arguments into adjacent entries.
  const mergedToolCalls = mergeSplitToolCalls(finalToolCalls, providerName);

  // Detect phantom tool calls: entries with empty name or arguments that
  // likely resulted from a provider-specific delta-merging quirk.
  const phantomCalls = mergedToolCalls.filter(
    tc => !tc.function.name || !tc.function.arguments,
  );
  if (phantomCalls.length > 0) {
    incrementRepairCounter(providerName, 'phantom_tool_call');
    log.warn(
      `[${providerName}] ${phantomCalls.length} suspicious tool call(s) detected ` +
      `(trace=${traceId ?? 'none'}) — may indicate a provider delta-merging issue: ` +
      JSON.stringify(phantomCalls.map(tc => ({
        id: tc.id, name: tc.function.name || '(empty)', argsLen: tc.function.arguments.length,
      }))),
    );
  }

  return {
    text,
    toolCalls: mergedToolCalls,
    reasoningContent: reasoningContent || undefined,
    finishReason,
    usage,
    model: responseModel,
  };
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

// ── Provider registry (extracted → providers/registry.ts) ──

export { createProvider, createDeepSeekProvider, createOpenAIProvider } from './registry.js';
