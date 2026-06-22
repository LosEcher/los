import type { SessionEventRecord } from '../session-events.js';
import type { ModelSettings } from '../model-settings.js';
import type { MCPServerConfig } from '../tools/external/mcp-client.js';
import type { Logger } from '@los/infra/logger';
import type { Message, ProviderDelta, ToolCall } from '../providers/index.js';
import type { IdentityLevel } from '../identity-loader.js';
import type { PreprocessorConfig } from '@los/input-preprocessor';

export interface AgentConfig {
  sessionId?: string;
  provider?: string;
  model?: string;
  modelSettings?: ModelSettings;
  /** Run spec ID for contract lineage and cross-agent correlation (AP6). */
  runSpecId?: string;
  /** Trace ID for cross-session correlation (AP6). */
  /**
   * Architect/Editor dual model configuration.
   * When set, loop.ts runs architect turns (planning) and editor turns (execution)
   * in alternating fashion. Architect uses a reasoning model, editor uses a cheaper
   * code-editing model with a simplified prompt.
   */
  architectEditor?: {
    enabled: boolean;
    /** Provider name for the architect model. Falls back to default provider if unset. */
    architectProvider?: string;
    /** Provider name for the editor model. Falls back to default provider if unset. */
    editorProvider?: string;
    /** Max architect turns before switching to editor. Default: 2. */
    maxArchitectTurns?: number;
  };
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
  /** Sandbox isolation mode. Maps to config sandboxMode. Default: 'workspace-write'. */
  sandboxMode?: 'readonly' | 'workspace-write' | 'sandbox';
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
  /** Context fill monitoring configuration. When set, enables 3-tier fill tracking. */
  contextMonitor?: {
    /** Model's advertised context window size. Default: 200_000 */
    contextWindowTokens?: number;
    /** Warn threshold (0-1). Default: 0.60 */
    warnThreshold?: number;
    /** Checkpoint threshold (0-1). Default: 0.75 */
    checkpointThreshold?: number;
    /** Critical / compact threshold (0-1). Default: 0.85 */
    criticalThreshold?: number;
    /** Callback on WARN level crossing */
    onWarn?: (state: { fillPercent: number; usedTokens: number; turn: number }) => void;
    /** Callback on CHECKPOINT level crossing */
    onCheckpoint?: (state: { fillPercent: number; usedTokens: number; turn: number }) => void;
    /** Callback on CRITICAL level crossing */
    onCritical?: (state: { fillPercent: number; usedTokens: number; turn: number }) => void;
  };
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
  /** Semantic eviction configuration — mask persisted tool results at critical fill. */
  semanticEviction?: {
    enabled?: boolean;
    /** Minimum result size in bytes to consider for eviction (default: 4096). */
    minResultBytes?: number;
    /** Maximum stub length in characters (default: 200). */
    maxStubChars?: number;
  };
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
