import type { ModelProfile } from '../model-profiles.js';
import { AgentError } from '../error-base.js';
import { recordProviderCall } from './telemetry.js';
import { buildOpenAIModelSettings } from '../model-settings.js';
import { buildOpenAICompatUrl, drainSseBuffer, repairToolCallArguments } from './openai-utils.js';
import type {
  ChatOptions,
  Message,
  Provider,
  ProviderDelta,
  ProviderModelInfo,
  ProviderResponse,
  ToolCall,
  ToolDef,
} from './types.js';

interface ResponsesConfig {
  name: string;
  apiKey: string;
  profile: ModelProfile;
  traceId?: string;
}

interface ResponsesInputItem {
  type: string;
  role?: string;
  content?: string | unknown[];
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
}

interface ResponsesToolCallState {
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
}

export function convertMessagesToResponsesInput(messages: Message[]): ResponsesInputItem[] {
  const input: ResponsesInputItem[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      input.push({ type: 'message', role: 'system', content: msg.content });
    } else if (msg.role === 'user') {
      input.push({ type: 'message', role: 'user', content: msg.content });
    } else if (msg.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id!,
        output: msg.content,
      });
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      } else if (msg.content) {
        input.push({ type: 'message', role: 'assistant', content: msg.content });
      }
    }
  }

  return input;
}

export function createOpenAIResponsesProvider(cfg: ResponsesConfig): Provider {
  const { name, apiKey, profile } = cfg;
  const { baseUrl, model } = profile;

  return {
    name,
    profile,

    async chat(messages: Message[], tools?: ToolDef[], options: ChatOptions = {}): Promise<ProviderResponse> {
      const input = convertMessagesToResponsesInput(messages);

      const body: Record<string, unknown> = {
        model,
        input,
        stream: Boolean(options.onDelta),
        ...buildOpenAIModelSettings(options.modelSettings),
      };

      if (tools?.length) {
        body.tools = tools.map(t => ({
          type: 'function',
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        }));
        body.tool_choice = 'auto';
      }

      const responsesUrl = buildOpenAICompatUrl(baseUrl, '/responses');
      const bodyStr = JSON.stringify(body);
      const fetchStart = Date.now();

      let res: Response;
      try {
        res = await fetch(responsesUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: bodyStr,
          signal: options.signal,
        });
      } catch (err: any) {
        recordProviderCall({
          traceId: options.traceId ?? '',
          sessionId: options.sessionId,
          provider: name, model, endpoint: '/responses', method: 'POST',
          stream: Boolean(options.onDelta), requestPayloadSize: bodyStr.length,
          status: 0, durationMs: Date.now() - fetchStart,
          errorCode: 'PROVIDER_NETWORK', errorMessage: err?.message?.slice(0, 500),
        }).catch(() => {});
        throw err;
      }
      recordProviderCall({
        traceId: options.traceId ?? '',
        sessionId: options.sessionId,
        provider: name, model, endpoint: '/responses', method: 'POST',
        stream: Boolean(options.onDelta), requestPayloadSize: bodyStr.length,
        status: res.status, durationMs: Date.now() - fetchStart,
        ...(res.ok ? {} : { errorCode: 'PROVIDER_HTTP_ERROR', errorMessage: `HTTP ${res.status}` }),
      }).catch(() => {});

      if (!res.ok) {
        const err = await res.text();
        throw AgentError.fromProviderResponse('PROVIDER_HTTP_ERROR', name, model, res.status, err, res.headers);
      }

      if (options.onDelta) {
        return await readResponsesStreamResponse(res, model, name, options.onDelta);
      }

      const data = await res.json() as any;
      return parseResponsesSyncResponse(data, model, name);
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
      return items.sort((a: ProviderModelInfo, b: ProviderModelInfo) => a.id.localeCompare(b.id));
    },
  };
}

function parseResponsesSyncResponse(data: any, fallbackModel: string, providerName: string): ProviderResponse {
  const outputItems = Array.isArray(data.output) ? data.output : [];
  let text = '';
  const toolCalls: ToolCall[] = [];

  for (const item of outputItems) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text') {
          text += (text ? '\n' : '') + (part.text ?? '');
        }
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id ?? item.id ?? `call_${toolCalls.length}`,
        type: 'function',
        function: {
          name: item.name ?? '',
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      });
    }
  }

  return {
    text,
    toolCalls: toolCalls.map(tc => repairToolCallArguments(tc, providerName)),
    usage: {
      promptTokens: data.usage?.input_tokens ?? 0,
      completionTokens: data.usage?.output_tokens ?? 0,
      cacheHitTokens: data.usage?.cache_read_input_tokens ?? 0,
      cacheMissTokens: data.usage?.cache_creation_input_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? undefined,
    },
    model: data.model ?? fallbackModel,
  };
}

export async function readResponsesStreamResponse(
  res: Response,
  fallbackModel: string,
  providerName: string,
  onDelta: (delta: ProviderDelta) => void | Promise<void>,
): Promise<ProviderResponse> {
  const reader = res.body?.getReader();
  if (!reader) throw new AgentError('PROVIDER_PARSE', `${providerName} Responses API returned no stream body`, { provider: providerName, retryable: false });

  const decoder = new TextDecoder();
  const toolCallStates = new Map<string, ResponsesToolCallState>(); // keyed by item_id
  let buffer = '';
  let text = '';
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
        const event = JSON.parse(payload);
        const eventType = event.type as string;

        // Track model from response.created
        if (eventType === 'response.created') {
          responseModel = event.response?.model ?? responseModel;
          continue;
        }

        // response.output_text.delta — text streaming
        if (eventType === 'response.output_text.delta') {
          const delta = event.delta ?? '';
          text += delta;
          await onDelta({ textDelta: delta, model: responseModel });
          continue;
        }

        // response.function_call_arguments.delta — tool call argument streaming
        if (eventType === 'response.function_call_arguments.delta') {
          const itemId = event.item_id as string;
          const delta = event.delta ?? '';
          let state = toolCallStates.get(itemId);
          if (!state) {
            state = { itemId, callId: event.call_id ?? itemId, name: event.name ?? '', arguments: '' };
            toolCallStates.set(itemId, state);
          }
          state.arguments += delta;
          continue;
        }

        // response.function_call_arguments.done — finalize tool call
        if (eventType === 'response.function_call_arguments.done') {
          const itemId = event.item_id as string;
          let state = toolCallStates.get(itemId);
          if (!state) {
            state = {
              itemId,
              callId: event.call_id ?? itemId,
              name: event.name ?? '',
              arguments: event.arguments ?? '',
            };
            toolCallStates.set(itemId, state);
          }
          // .done carries authoritative name and arguments — overwrite both
          if (event.name) {
            state.name = event.name;
          }
          if (event.arguments) {
            state.arguments = typeof event.arguments === 'string' ? event.arguments : JSON.stringify(event.arguments);
          }
          continue;
        }

        // response.completed — final usage info
        if (eventType === 'response.completed') {
          if (event.response?.usage) {
            usage = normalizeResponsesUsage(event.response.usage, usage);
          }
          continue;
        }
      }
    }
    if (done) break;
  }

  const toolCalls: ToolCall[] = [...toolCallStates.values()].map(state => ({
    id: state.callId,
    type: 'function' as const,
    function: { name: state.name, arguments: state.arguments },
  }));

  return {
    text,
    toolCalls: toolCalls.map(tc => repairToolCallArguments(tc, providerName)),
    usage,
    model: responseModel,
  };
}

function normalizeResponsesUsage(raw: any, fallback: ProviderResponse['usage']): ProviderResponse['usage'] {
  if (!raw) return fallback;
  return {
    promptTokens: raw.input_tokens ?? fallback.promptTokens,
    completionTokens: raw.output_tokens ?? fallback.completionTokens,
    cacheHitTokens: raw.cache_read_input_tokens ?? fallback.cacheHitTokens ?? 0,
    cacheMissTokens: raw.cache_creation_input_tokens ?? fallback.cacheMissTokens ?? 0,
    totalTokens: raw.total_tokens ?? fallback.totalTokens,
  };
}
