import type { SessionEventRecord } from '../session-events.js';
import type { ModelSettings } from '../model-settings.js';
import type { MCPServerConfig } from '../tools/mcp-client.js';
import type { Message, ProviderDelta, ToolCall } from '../providers/index.js';

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
  onToolCallState?: (transition: ToolCallStateTransition) => void | Promise<void>;
  onSessionEvent?: (event: SessionEventRecord) => void | Promise<void>;
  onTurn?: (turn: TurnSummary) => void | Promise<void>;
  onToolCall?: (tool: string, args: Record<string, unknown>) => void | Promise<void>;
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
