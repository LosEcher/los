import type { SessionEventRecord } from '../session-events.js';
import type { ModelSettings } from '../model-settings.js';
import type { MCPServerConfig } from '../tools/external/mcp-client.js';
import type { Logger } from '@los/infra/logger';
import type { Message, ProviderDelta, ToolCall } from '../providers/index.js';
import type { IdentityLevel } from '../identity-loader.js';
import type { ModelDiagnosticConfig } from '../model-diagnostics.js';
import type { AgentPreActionGateConfig } from '../pre-action-gate.js';
import type { ProviderFallbackPolicy } from '../providers/provider-fallback.js';
import type { ProviderFallbackEvent } from '../providers/provider-fallback.js';
import type { PlanningOutput, PlanningTransport } from '../planning-output.js';

export interface AgentConfig {
  sessionId?: string;
  provider?: string;
  model?: string;
  /** Explicit ordered provider/model policy. No provider switch occurs when unset. */
  providerFallback?: ProviderFallbackPolicy;
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
  /** Planning submission carrier. typed_tool is the scheduler default. */
  planningTransport?: PlanningTransport;
  toolRetry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
  /** Advisory checks against persisted tool-failure and fragile-file evidence. */
  preActionGate?: AgentPreActionGateConfig;
  signal?: AbortSignal;
  maxContextTokens?: number;
  contextCompression?: ContextCompressionConfig;
  mcpServers?: MCPServerConfig[];
  /** Run contract metadata (mode, phase, plan, verifications). Passed from scheduler. */
  runContractMetadata?: Record<string, unknown>;
  /** Interval (in turns) for stop-condition runtime checks. Default 5, 0 to disable. */
  stopConditionCheckInterval?: number;
  /** Scheduler-owned planning disposition runs the normal read-only tool loop. */
  skipPreExecutionPhases?: boolean;
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
  /** Scheduler-owned persistence hook for effective provider/model switches. */
  onProviderFallback?: (event: ProviderFallbackEvent) => void | Promise<void>;
  onTurn?: (turn: TurnSummary) => void | Promise<void>;
  onToolCall?: (callId: string, tool: string, args: Record<string, unknown>, turn: number) => void | Promise<void>;
  onModelDelta?: (delta: AgentModelDelta) => void | Promise<void>;
  onCheckpoint?: (state: CheckpointState) => void | Promise<void>;
  /** Resume state from a previous checkpoint (messages + turns). */
  resumeState?: CheckpointState;
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
    /** Callback when cache hit rate drops below the warn threshold (default 0.70) */
    onCacheLow?: (state: { fillPercent: number; usedTokens: number; turn: number }) => void;
  };
  /** Advisory model diagnostics. Defaults to heuristic shadow mode when unset. */
  modelDiagnostics?: ModelDiagnosticConfig;
  /**
   * Deferred tool loading: when 'name-only', system prompt only sends {name, description}
   * instead of full JSON schemas. Full schema is loaded on first invocation and cached.
   * Default: 'full' (no change in behavior).
   */
  deferredToolLoading?: {
    mode: 'name-only' | 'full';
    /** Pre-materialize top-N most-used tools at startup (default: none). */
    preloadTopN?: number;
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
  planningSubmission?: PlanningOutput;
  /** Wall-clock duration of the agent loop in milliseconds. */
  durationMs?: number;
}

export interface ContextCompressionConfig {
  enabled?: boolean;
  warningRatio?: number;
  aggressiveRatio?: number;
  emergencyRatio?: number;
  /**
   * Provider context window size in tokens. When set and > 200K (e.g. Kimi-K3 1M window),
   * compression thresholds use absolute token budgets instead of percentage ratios:
   * warning at 300K, aggressive at 500K, emergency at 750K. This prevents premature
   * compression on large-window providers while still capping memory pressure.
   */
  providerContextWindow?: number;
  /** Max ineffective compaction attempts before throttle. Default: 3. Set to 0 to disable. */
  maxCompactionAttempts?: number;
  /** Semantic eviction configuration — mask persisted tool results at critical fill. */
  semanticEviction?: {
    enabled?: boolean;
    /** Minimum result size in bytes to consider for eviction (default: 4096). */
    minResultBytes?: number;
    /** Maximum stub length in characters (default: 200). */
    maxStubChars?: number;
  };
  /**
   * Deterministic masking cascade (G6): at the warning tier, tool results in
   * old turns are replaced with compact mask cards (structure preserved)
   * instead of being collapsed into a single summary. The aggressive tier
   * then collapses masked turns into one summary; emergency stays hard trim.
   */
  masking?: {
    enabled?: boolean;
    /** Maximum mask card length in characters (default: 240). */
    maxCardChars?: number;
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

// ── Execution Projection ────────────────────────────────

/**
 * Transport-neutral typed projection of agent execution state.
 * CLI and Web share this reducer; each renderer maps it to its own output.
 *
 * Design reference: Grok Build AcpUpdateTracker (typed state machine)
 * and the LOS agent-workflow-roadmap Stage D requirement for a single
 * replay/live event identity.
 */
export interface ExecutionProjection {
  /** Monotonic event sequence for replay deduplication */
  lastEventId: number;
  /** Current run phase (from run contract) */
  phase: string;
  /** Latest model response text, if any */
  text?: string;
  /** Active reasoning/thinking content from the model */
  reasoningContent?: string;
  /** Current turn number */
  turn: number;
  /** Whether the run was stopped by a stop-condition match */
  stoppedByCondition?: boolean;
  /** Pending parallel tool calls (name + args) */
  toolCalls: Array<{ callId: string; name: string; args: Record<string, unknown> }>;
  /** Completed tool results in original call order */
  toolResults: Array<{
    callId: string;
    name: string;
    content: string;
    error?: string;
    durationMs?: number;
    denied?: boolean;
  }>;
  /** Human-readable waiting reason (e.g. "planning", "verifying", "approval_required") */
  waitingReason?: string;
  /** Retry state for the current turn */
  retry?: { attempt: number; maxAttempts: number; reason?: string };
  /** Compaction summary when context was reduced */
  compaction?: {
    compressedAt: string;
    messageCountBefore: number;
    messageCountAfter: number;
    semanticEvictionCount?: number;
  };
  /** Terminal outcome when the run completes */
  terminal?: {
    outcome: 'succeeded' | 'failed' | 'cancelled' | 'blocked';
    loopCount: number;
    totalTokens: { prompt: number; completion: number };
    planningSubmission?: { planStepCount: number; summary?: string };
  };
  /** Context fill state for display */
  contextFill?: {
    fillPercent: number;
    level: 'normal' | 'warn' | 'checkpoint' | 'critical';
    usedTokens: number;
    contextWindowTokens: number;
  };
  /** Provider/model used for the current turn */
  provider?: { name: string; model: string };
  /** Elapsed wall-clock time since run started (ms) */
  elapsedMs?: number;
}

/**
 * Frame budget for UI rendering: batch deltas and cap refresh rate.
 * CLI and Web should respect these limits to avoid jank.
 */
export interface ProjectionFrameBudget {
  /** Max deltas to process per frame (default 50) */
  maxDeltasPerFrame: number;
  /** Min interval between frames in ms (default 33 ~= 30fps) */
  minFrameIntervalMs: number;
}
