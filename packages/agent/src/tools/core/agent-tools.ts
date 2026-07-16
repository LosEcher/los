import { randomUUID } from 'node:crypto';
import { resolveIdentityLevelForExecutionPath } from '../../identity-loader.js';
import { READ_ONLY_BUILTIN_TOOLS } from './registry.js';
import type { AgentConfig, AgentResult } from '../../loop.js';
import type { ToolRegistry, ToolResult } from './registry.js';

export interface SpawnAgentRequest {
  prompt: string;
  provider?: string;
  model?: string;
  toolMode?: 'read-only' | 'project-write';
  maxLoops?: number;
}

export type SpawnAgentRunner = (request: SpawnAgentRequest) => Promise<ToolResult>;
export type ChildAgentRunner = (prompt: string, config: AgentConfig) => Promise<AgentResult>;

export interface SpawnAgentRunnerOptions {
  runAgent: ChildAgentRunner;
  sessionId?: string;
  provider?: string;
  model?: string;
  modelSettings?: AgentConfig['modelSettings'];
  runContractMetadata?: AgentConfig['runContractMetadata'];
  workspaceRoot?: string;
  /** Inherit parent traceId for cross-agent tracing (AP6). */
  traceId?: string;
  /** Inherit parent requestId for request correlation (AP6). */
  requestId?: string;
  /** Inherit parent runSpecId for run-spec lineage (AP6). */
  runSpecId?: string;
  tenantId?: string;
  projectId?: string;
  /** Inherit parent architect-editor config for dual-model sub-agents (AP6). */
  architectEditor?: AgentConfig['architectEditor'];
  preActionGate?: AgentConfig['preActionGate'];
  toolRetry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
  signal?: AbortSignal;
  onSessionEvent?: (event: import('../../session-events.js').SessionEventRecord) => void | Promise<void>;
}

const SUBAGENT_PROJECT_WRITE_TOOLS = [
  'read_file',
  'write_file',
  'preview_patch',
  'apply_patch',
  'edit_file',
  'list_directory',
] as const;

export function registerSpawnAgentTool(registry: ToolRegistry, runner: SpawnAgentRunner): void {
  registry.register('spawn_agent', async (args) => {
    const prompt = normalizeString(args.prompt);
    if (!prompt) return { content: '', error: 'prompt is required' };

    return runner({
      prompt,
      provider: normalizeString(args.provider),
      model: normalizeString(args.model),
      toolMode: normalizeToolMode(args.toolMode),
      maxLoops: normalizeInteger(args.maxLoops),
    });
  }, {
    type: 'function',
    function: {
      name: 'spawn_agent',
      description: 'Run a constrained child coding agent for focused investigation or project-write edits. The child cannot spawn further agents or run shell commands.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Focused task for the child agent' },
          provider: { type: 'string', description: 'Optional provider override' },
          model: { type: 'string', description: 'Optional model override for the child provider' },
          toolMode: { type: 'string', enum: ['read-only', 'project-write'], description: 'Child tool mode. Defaults to read-only.' },
          maxLoops: { type: 'number', description: 'Child loop budget, clamped by the parent runtime' },
        },
        required: ['prompt'],
      },
    },
  }, {
    riskLevel: 'L1',
    permissions: ['agent:spawn'],
    timeoutMs: 600_000,
    retryable: false,
    idempotent: false,
    costLevel: 'high',
    sideEffect: true,
    tags: ['agent', 'subagent'],
  });
}

/** Deep-clone parent runContractMetadata so child mutations cannot widen parent phase/checks (AP6). */
function inheritRunContractMetadata(
  parent: SpawnAgentRunnerOptions['runContractMetadata'],
): SpawnAgentRunnerOptions['runContractMetadata'] {
  if (!parent) return undefined;
  try {
    return structuredClone(parent);
  } catch {
    // Fallback for non-cloneable values (functions, etc.)
    return JSON.parse(JSON.stringify(parent)) as SpawnAgentRunnerOptions['runContractMetadata'];
  }
}

export function createSpawnAgentRunner(options: SpawnAgentRunnerOptions): SpawnAgentRunner {
  return async (request) => {
    const childToolMode = request.toolMode ?? 'read-only';
    const childMaxLoops = Math.max(1, Math.min(request.maxLoops ?? 8, 12));
    const childSessionId = options.sessionId ? `${options.sessionId}:child:${randomUUID()}` : undefined;
    // AP6: full contract inheritance (phase, surfaces, requiredChecks) as an isolated clone
    const childRunContractMetadata = inheritRunContractMetadata(options.runContractMetadata);
    const childResult = await options.runAgent(request.prompt, {
      sessionId: childSessionId,
      provider: request.provider ?? options.provider,
      model: request.model ?? options.model,
      modelSettings: options.modelSettings,
      runContractMetadata: childRunContractMetadata,
      // Inherit trace/request/dedupe linkage from parent
      traceId: options.traceId,
      requestId: options.requestId,
      runSpecId: options.runSpecId,
      tenantId: options.tenantId,
      projectId: options.projectId,
      maxLoops: childMaxLoops,
      workspaceRoot: options.workspaceRoot,
      toolMode: childToolMode,
      allowedTools: childToolMode === 'read-only'
        ? READ_ONLY_BUILTIN_TOOLS
        : SUBAGENT_PROJECT_WRITE_TOOLS,
      toolRetry: options.toolRetry,
      signal: options.signal,
      onSessionEvent: options.onSessionEvent,
      // Inherit architect-editor config from parent if enabled
      architectEditor: options.architectEditor,
      preActionGate: options.preActionGate,
      // Child agents get Minimal identity: a role label only.
      // Per Agent Identity Decision Framework: short-lived, single-purpose,
      // constrained tools — identity should not consume context budget.
      identity: { name: 'child', level: resolveIdentityLevelForExecutionPath('child-spawned') },
    });

    return {
      content: JSON.stringify({
        childSessionId: childSessionId ?? null,
        provider: request.provider ?? options.provider ?? null,
        model: request.model ?? options.model ?? null,
        toolMode: childToolMode,
        loopCount: childResult.loopCount,
        totalTokens: childResult.totalTokens,
        text: childResult.text,
      }, null, 2),
    };
  };
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeToolMode(value: unknown): SpawnAgentRequest['toolMode'] | undefined {
  if (value === 'project-write' || value === 'read-only') return value;
  return undefined;
}

function normalizeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.floor(value);
}
