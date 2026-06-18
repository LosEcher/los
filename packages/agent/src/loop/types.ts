import type { SessionEventRecord } from '../session-events.js';
import type { ModelSettings } from '../model-settings.js';
import type { MCPServerConfig } from '../tools/mcp-client.js';
import type { Logger } from '@los/infra/logger';
import type { Message, ProviderDelta, ToolCall } from '../providers/index.js';
import type { IdentityLevel } from '../identity-loader.js';
import type { PreprocessorConfig } from '@los/input-preprocessor';

export interface AgentConfig {
  sessionId?: string;
  provider?: string;
  model?: string;
  modelSettings?: ModelSettings;
  initialMessages?: Message[];
  maxLoops?: number;
  systemPrompt?: string;
  workspaceRoot?: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  nodeId?: string;
  requestId?: string;
  traceId?: string;
  toolMode?: 'all' | 'project-write' | 'read-only';
  allowedTools?: readonly string[];
  toolRetry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
  signal?: AbortSignal;
  maxContextTokens?: number;
  contextCompression?: ContextCompressionConfig;
  mcpServers?: MCPServerConfig[];
  /** Run contract metadata (mode, phase, plan, verifications). Passed from scheduler. */
  runContractMetadata?: Record<string, unknown>;
  /** Agent identity configuration. When set and systemPrompt is not explicitly provided,
   *  identity is resolved and prepended to the default system prompt. */
  identity?: {
    /** Agent name for identity resolution (e.g., 'default', 'child'). */
    name?: string;
    /** Identity level override. 'none' disables identity injection. */
    level?: IdentityLevel;
  };
  /** Request-scoped logger with traceId/requestId bound. Falls back to module-level logger. */
  log?: Logger;
  onToolCallState?: (transition: ToolCallStateTransition) => void | Promise<void>;
  onSessionEvent?: (event: SessionEventRecord) => void | Promise<void>;
  onTurn?: (turn: TurnSummary) => void | Promise<void>;
  onToolCall?: (callId: string, tool: string, args: Record<string, unknown>, turn: number) => void | Promise<void>;
  onModelDelta?: (delta: AgentModelDelta) => void | Promise<void>;
  onCheckpoint?: (state: CheckpointState) => void | Promise<void>;
}

export interface AgentModelDelta extends ProviderDelta {
  turn: number;
  provider: string;
}

export interface TurnSummary {
  loopCount: number;
  text: string;
  toolCalls: ToolCall[];
  toolResults: string[];
  reasoningContent?: string;
}

export interface CheckpointState {
  messages: Message[];
  turns: TurnSummary[];
}

export interface AgentResult {
  text: string;
  turns: TurnSummary[];
  loopCount: number;
  totalTokens: { prompt: number; completion: number };
  messages: Message[];
}

export interface ContextCompressionConfig {
  enabled?: boolean;
  warningRatio?: number;
  aggressiveRatio?: number;
  emergencyRatio?: number;
  /** Input preprocessing configuration (log denoising, dedup, etc.). */
  preprocessor?: Partial<PreprocessorConfig>;
}

export interface ToolCallStateTransition {
  callId: string;
  toolName: string;
  state: 'requested' | 'approved' | 'denied' | 'running' | 'succeeded' | 'failed' | 'retrying';
  turn: number;
  input?: Record<string, unknown>;
  outputSummary?: string;
  error?: string;
  durationMs?: number;
  attempt?: number;
  maxAttempts?: number;
  idempotent?: boolean;
  retryPolicy?: Record<string, unknown>;
}
