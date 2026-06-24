import type { ModelProfile } from '../model-profiles.js';
import type { ModelSettings } from '../model-settings.js';

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
  /** Present when the provider repaired malformed arguments. Set by provider adapters. */
  _repair?: {
    repaired: boolean;
    originalArguments?: string;
    repairSteps?: string[];
  };
}

export interface ProviderResponse {
  text: string;
  toolCalls: ToolCall[];
  reasoningContent?: string;
  /** Canonical finish reason. Provider adapters MUST normalize their native
   *  stop reason to this vocabulary via `normalizeFinishReason()` before
   *  returning a response, so the loop can reason about truncation uniformly
   *  across providers:
   *    'stop'           — natural end
   *    'length'         — truncated by token limit (OpenAI 'length',
   *                       Anthropic 'max_tokens', Responses 'incomplete')
   *    'tool_calls'     — model wants to call tools (Anthropic 'tool_use')
   *    'content_filter' — blocked by safety policy
   *  Unknown native reasons pass through as-is for observability. */
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | string;
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
  onDelta?: (delta: ProviderDelta) => void | Promise<void>;
  modelSettings?: ModelSettings;
  /** Request trace id — passed through for diagnostic logging. */
  traceId?: string;
  /** Session id — passed through for provider call telemetry. */
  sessionId?: string;
}

export interface ProviderDelta {
  textDelta?: string;
  reasoningDelta?: string;
  model?: string;
}

export interface ProviderModelInfo {
  id: string;
  object?: string;
  ownedBy?: string;
  raw?: Record<string, unknown>;
}

export interface Provider {
  name: string;
  profile: ModelProfile;
  chat(messages: Message[], tools?: ToolDef[], options?: ChatOptions): Promise<ProviderResponse>;
  listModels?(options?: { signal?: AbortSignal }): Promise<ProviderModelInfo[]>;
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface CreateProviderOptions {
  model?: string;
  baseUrl?: string;
  apiShape?: string;
  /** Request trace id — passed through for diagnostic logging. */
  traceId?: string;
}

// ── Finish-reason normalization ─────────────────────────
// Each provider speaks a different stop-reason vocabulary. Adapters translate
// their native reason to the canonical vocabulary defined on
// `ProviderResponse.finishReason` so the agent loop can detect truncation
// (`'length'`) uniformly. See ADR 0007 (provider loop) and the truncation
// handling in `loop.ts`.

/** Anthropic Messages API `stop_reason` → canonical finish reason. */
const ANTHROPIC_STOP_REASON_MAP: Record<string, string> = {
  end_turn: 'stop',
  max_tokens: 'length',
  stop_sequence: 'stop',
  tool_use: 'tool_calls',
};

/** OpenAI Responses API `response.status` → canonical finish reason.
 *  `incomplete` means the response was truncated (e.g. `max_output_tokens`
 *  reached); `completed` is a natural finish. `failed`/`cancelled` pass
 *  through unchanged for observability. */
const RESPONSES_STATUS_MAP: Record<string, string> = {
  completed: 'stop',
  incomplete: 'length',
};

/**
 * Normalize a provider-native stop reason to the canonical finish-reason
 * vocabulary. OpenAI Chat Completions already uses the canonical vocabulary
 * and is passed through unchanged (with a null/empty guard). Anthropic
 * `stop_reason` and Responses API `status` are translated.
 *
 * Unknown native values pass through as-is so they remain observable in
 * telemetry rather than being silently coerced to `'stop'`.
 */
export function normalizeFinishReason(
  native: string | undefined,
  family: 'openai' | 'anthropic' | 'responses',
): string | undefined {
  if (!native) return undefined;
  if (family === 'anthropic') {
    return ANTHROPIC_STOP_REASON_MAP[native] ?? native;
  }
  if (family === 'responses') {
    return RESPONSES_STATUS_MAP[native] ?? native;
  }
  return native; // openai: already canonical
}
