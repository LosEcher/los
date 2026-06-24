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
  /** The finish reason from the provider. 'stop' = natural end, 'length' = truncated,
   *  'tool_calls' = model wants to call tools, 'content_filter' = blocked by safety. */
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
