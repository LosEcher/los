import type { SessionEventRecord } from '../session-events.js';
import type { ModelSettings } from '../model-settings.js';
import type { MCPServerConfig } from '../tools/external/mcp-client.js';
import type { Logger } from '@los/infra/logger';
import type { Message, ProviderDelta, ToolCall } from '../providers/index.js';
import type { IdentityLevel } from '../identity-loader.js';
import type { ModelDiagnosticConfig } from '../model-diagnostics.js';

export interface AgentConfig {
  sessionId?: string;
  provider?: string;
  model?: string;
  modelSettings?: ModelSettings;
  /** Run spec ID for contract lineage and cross-agent correlation (AP6). */
  runSpecId?: string;
  /** Task run ID for the current execution. Set by scheduled-task-runner so that
   *  built-in worker tools (ask_coordinator/escalate) can correlate the worker
   *  message + blocked transition to this task_run. Undefined for direct runAgent
   *  calls outside a scheduled task (worker tools will refuse to block in that case). */
  taskRunId?: string;
  /** Dispatch ID (= agent_task_attempts.id) for the current graph-path execution.
   *  Used as the worker_messages.dispatch_id so the coordinator can scope messages
   *  to a specific dispatch. Undefined for non-graph (direct scheduled) tasks. */
  dispatchId?: string;
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
    /** Model override for the architect provider. Falls back to the provider's profile default. */
    architectModel?: string;
    /** Model override for the editor provider. Falls back to the provider's profile default. */
    editorModel?: string;
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
  /** Advisory model diagnostics. Defaults to heuristic shadow mode when unset. */
  modelDiagnostics?: ModelDiagnosticConfig;
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
