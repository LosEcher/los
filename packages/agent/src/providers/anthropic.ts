import type { ModelProfile } from '../model-profiles.js';
import { AgentError } from '../error-base.js';
import { recordProviderCall } from './telemetry.js';
import { buildAnthropicModelSettings } from '../model-settings.js';
import type {
  ChatOptions,
  Message,
  Provider,
  ProviderResponse,
  ToolCall,
  ToolDef,
} from './types.js';

interface AnthropicConfig {
  name: string;
  apiKey: string;
  profile: ModelProfile;
  traceId?: string;
}

/**
 * Anthropic Messages API adapter.
 * MiniMax speaks this protocol natively at api.minimaxi.com/anthropic.
 * Claude uses api.anthropic.com/v1/messages.
 *
 * From lsclaw's `callAnthropic()` and pi's `streamAnthropic()`.
 */
export function createAnthropicProvider(cfg: AnthropicConfig): Provider {
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
        messages: anthropicMessages,
        ...buildAnthropicModelSettings(options.modelSettings, MAX_TOKENS),
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

      const bodyStr = JSON.stringify(body);
      const fetchStart = Date.now();

      let res: Response;
      try {
        res = await fetch(messagesUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': API_VERSION,
          },
          body: bodyStr,
          signal: options.signal,
        });
      } catch (err: any) {
        recordProviderCall({
          traceId: options.traceId ?? '',
          sessionId: options.sessionId,
          provider: name, model, endpoint: '/v1/messages', method: 'POST',
          stream: Boolean(options.onDelta), requestPayloadSize: bodyStr.length,
          status: 0, durationMs: Date.now() - fetchStart,
          errorCode: 'PROVIDER_NETWORK', errorMessage: err?.message?.slice(0, 500),
        }).catch(() => {});
        throw err;
      }
      recordProviderCall({
        traceId: options.traceId ?? '',
        sessionId: options.sessionId,
        provider: name, model, endpoint: '/v1/messages', method: 'POST',
        stream: Boolean(options.onDelta), requestPayloadSize: bodyStr.length,
        status: res.status, durationMs: Date.now() - fetchStart,
        ...(res.ok ? {} : { errorCode: 'PROVIDER_HTTP_ERROR', errorMessage: `HTTP ${res.status}` }),
      }).catch(() => {});

      if (!res.ok) {
        const err = await res.text();
        throw AgentError.fromProviderResponse('PROVIDER_HTTP_ERROR', name, model, res.status, err, res.headers);
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
        finishReason: data.stop_reason ?? undefined,
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
