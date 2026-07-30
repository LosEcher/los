import { randomUUID } from 'node:crypto';
import { resolveIdentityLevelForExecutionPath } from '../../identity-loader.js';
import { READ_ONLY_BUILTIN_TOOLS } from './registry.js';
import { createRunSpec, ensureRunSpecStore } from '../../run-specs.js';
import type { AgentConfig, AgentResult } from '../../loop.js';
import type { ToolRegistry, ToolResult } from './registry.js';

export interface SpawnAgentRequest {
  prompt: string;
  provider?: string;
  model?: string;
  toolMode?: 'read-only' | 'project-write';
  maxLoops?: number;
  /** Execution mode. Default: 'sync'. 'background' returns immediately with an agentId for later query. */
  mode?: 'sync' | 'background';
}

export type SpawnAgentRunner = (request: SpawnAgentRequest) => Promise<ToolResult>;
export type ChildAgentRunner = (prompt: string, config: AgentConfig) => Promise<AgentResult>;

export interface SpawnAgentRunnerOptions {
  runAgent: ChildAgentRunner;
  sessionId?: string;
  provider?: string;
  model?: string;
  providerFallback?: AgentConfig['providerFallback'];
  modelSettings?: AgentConfig['modelSettings'];
  runContractMetadata?: AgentConfig['runContractMetadata'];
  workspaceRoot?: string;
  traceId?: string;
  requestId?: string;
  runSpecId?: string;
  tenantId?: string;
  projectId?: string;
  architectEditor?: AgentConfig['architectEditor'];
  preActionGate?: AgentConfig['preActionGate'];
  toolRetry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
  signal?: AbortSignal;
  onSessionEvent?: (event: import('../../session-events.js').SessionEventRecord) => void | Promise<void>;
  onProviderFallback?: AgentConfig['onProviderFallback'];
}

const SUBAGENT_PROJECT_WRITE_TOOLS = [
  'read_file',
  'write_file',
  'preview_patch',
  'apply_patch',
  'edit_file',
  'list_directory',
] as const;

// ── Background Agent Tracker ────────────────────────────

interface TrackedAgent {
  agentId: string;
  childRunSpecId?: string;
  childSessionId: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  startedAt: number;
  prompt: string;
  result?: {
    text: string;
    loopCount: number;
    totalTokens: number;
  };
  error?: string;
  abortController: AbortController;
}

const trackedAgents = new Map<string, TrackedAgent>();

function trackAgent(agent: TrackedAgent): void {
  trackedAgents.set(agent.agentId, agent);
  // Auto-cleanup 10 min after completion
  const check = () => {
    const a = trackedAgents.get(agent.agentId);
    if (a && a.status !== 'running') trackedAgents.delete(agent.agentId);
  };
  setTimeout(check, 600_000).unref();
}

function getAgent(agentId: string): TrackedAgent | undefined {
  return trackedAgents.get(agentId);
}

function killAgent(agentId: string): boolean {
  const agent = trackedAgents.get(agentId);
  if (!agent || agent.status !== 'running') return false;
  agent.abortController.abort();
  agent.status = 'killed';
  return true;
}

function listAgents(): TrackedAgent[] {
  return [...trackedAgents.values()];
}

// ── Tool Registration ───────────────────────────────────

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
      mode: normalizeMode(args.mode),
    });
  }, {
    type: 'function',
    function: {
      name: 'spawn_agent',
      description: 'Run a constrained child coding agent for focused investigation or project-write edits. The child cannot spawn further agents or run shell commands. Each child agent creates a durable run_spec record with parent lineage for traceability and recovery. Use mode=background to run asynchronously and query results later with query_agent.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Focused task for the child agent' },
          provider: { type: 'string', description: 'Optional provider override' },
          model: { type: 'string', description: 'Optional model override for the child provider' },
          toolMode: { type: 'string', enum: ['read-only', 'project-write'], description: 'Child tool mode. Defaults to read-only.' },
          maxLoops: { type: 'number', description: 'Child loop budget, clamped by the parent runtime' },
          mode: { type: 'string', enum: ['sync', 'background'], description: 'Execution mode. sync (default) waits for completion. background returns immediately with agentId for later query_agent/kill_agent.' },
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

export function registerAgentQueryKillTools(registry: ToolRegistry): void {
  registry.register('query_agent', async (args) => {
    const agentId = normalizeString(args.agentId);
    if (!agentId) return { content: '', error: 'agentId is required' };
    const agent = getAgent(agentId);
    if (!agent) return { content: '', error: `Agent not found: ${agentId}` };
    return {
      content: JSON.stringify({
        agentId: agent.agentId,
        childRunSpecId: agent.childRunSpecId ?? null,
        childSessionId: agent.childSessionId,
        status: agent.status,
        startedAt: new Date(agent.startedAt).toISOString(),
        prompt: agent.prompt,
        result: agent.result ?? null,
        error: agent.error ?? null,
      }, null, 2),
    };
  }, {
    type: 'function',
    function: {
      name: 'query_agent',
      description: 'Check the status and result of a background child agent. Returns running/completed/failed/killed status, and the result text when completed.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'The agentId returned by spawn_agent with mode=background' },
        },
        required: ['agentId'],
      },
    },
  }, {
    riskLevel: 'L0',
    permissions: ['agent:query'],
    timeoutMs: 5_000,
    retryable: true,
    idempotent: true,
    sideEffect: false,
    tags: ['agent', 'subagent'],
  });

  registry.register('kill_agent', async (args) => {
    const agentId = normalizeString(args.agentId);
    if (!agentId) return { content: '', error: 'agentId is required' };
    const killed = killAgent(agentId);
    return {
      content: JSON.stringify({
        agentId,
        killed,
        message: killed ? 'Agent aborted' : 'Agent not found or already completed',
      }, null, 2),
    };
  }, {
    type: 'function',
    function: {
      name: 'kill_agent',
      description: 'Abort a running background child agent. Idempotent — returns killed=false if already completed or not found.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'The agentId returned by spawn_agent with mode=background' },
        },
        required: ['agentId'],
      },
    },
  }, {
    riskLevel: 'L0',
    permissions: ['agent:kill'],
    timeoutMs: 5_000,
    retryable: false,
    idempotent: true,
    sideEffect: true,
    tags: ['agent', 'subagent'],
  });

  registry.register('list_agents', async (_args) => {
    const agents = listAgents();
    return {
      content: JSON.stringify(agents.map(a => ({
        agentId: a.agentId,
        childRunSpecId: a.childRunSpecId ?? null,
        status: a.status,
        prompt: a.prompt.slice(0, 120),
        startedAt: new Date(a.startedAt).toISOString(),
      })), null, 2),
    };
  }, {
    type: 'function',
    function: {
      name: 'list_agents',
      description: 'List all tracked background child agents and their statuses.',
      parameters: { type: 'object', properties: {} },
    },
  }, {
    riskLevel: 'L0',
    permissions: ['agent:list'],
    timeoutMs: 5_000,
    retryable: true,
    idempotent: true,
    sideEffect: false,
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
    return JSON.parse(JSON.stringify(parent)) as SpawnAgentRunnerOptions['runContractMetadata'];
  }
}

export function createSpawnAgentRunner(options: SpawnAgentRunnerOptions): SpawnAgentRunner {
  return async (request) => {
    const childToolMode = request.toolMode ?? 'read-only';
    const childMaxLoops = Math.max(1, Math.min(request.maxLoops ?? 8, 12));
    const childSessionId = options.sessionId ? `${options.sessionId}:child:${randomUUID()}` : `child:${randomUUID()}`;
    const childRunContractMetadata = inheritRunContractMetadata(options.runContractMetadata);
    const childOverridesRoute = Boolean(request.provider || request.model);
    const isBackground = request.mode === 'background';

    // Durable child lineage
    let childRunSpecId: string | undefined;
    try {
      await ensureRunSpecStore();
      const specId = `run-child-${childSessionId}-${Date.now()}`;
      await createRunSpec({
        id: specId,
        sessionId: childSessionId,
        tenantId: options.tenantId,
        projectId: options.projectId,
        traceId: options.traceId,
        requestId: options.requestId,
        parentRunSpecId: options.runSpecId,
        prompt: request.prompt,
        provider: request.provider ?? options.provider ?? undefined,
        model: request.model ?? options.model ?? undefined,
        workspaceRoot: options.workspaceRoot ?? '',
        toolMode: childToolMode,
        allowedTools: childToolMode === 'read-only'
          ? [...READ_ONLY_BUILTIN_TOOLS]
          : [...SUBAGENT_PROJECT_WRITE_TOOLS],
        maxLoops: childMaxLoops,
        runContract: childRunContractMetadata,
      });
      childRunSpecId = specId;
    } catch {
      childRunSpecId = undefined; // ensure caller never sees stale ID
    }

    // Background mode: fire-and-forget with AbortController
    if (isBackground) {
      const abortController = new AbortController();
      const agentId = `agent-${childSessionId}`;
      const tracked: TrackedAgent = {
        agentId,
        childRunSpecId,
        childSessionId,
        status: 'running',
        startedAt: Date.now(),
        prompt: request.prompt,
        abortController,
      };
      trackAgent(tracked);

      // Fire and forget — result is stored on the tracked agent
      void options.runAgent(request.prompt, {
        sessionId: childSessionId,
        provider: request.provider ?? options.provider,
        model: request.model ?? options.model,
        providerFallback: childOverridesRoute ? undefined : options.providerFallback,
        modelSettings: options.modelSettings,
        runContractMetadata: childRunContractMetadata,
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
        signal: abortController.signal,
        onSessionEvent: options.onSessionEvent,
        onProviderFallback: options.onProviderFallback,
        architectEditor: options.architectEditor,
        preActionGate: options.preActionGate,
        identity: { name: 'child', level: resolveIdentityLevelForExecutionPath('child-spawned') },
      }).then(result => {
        const agent = getAgent(agentId);
        if (!agent || agent.status === 'killed') return;
        agent.status = 'completed';
        agent.result = {
          text: result.text,
          loopCount: result.loopCount,
          totalTokens: result.totalTokens.prompt + result.totalTokens.completion,
        };
        // Schedule cleanup after completion
        setTimeout(() => trackedAgents.delete(agentId), 300_000).unref();
      }).catch(err => {
        const agent = getAgent(agentId);
        if (!agent || agent.status === 'killed') return;
        agent.status = 'failed';
        agent.error = err instanceof Error ? err.message : String(err);
        // Schedule cleanup after failure
        setTimeout(() => trackedAgents.delete(agentId), 300_000).unref();
      });

      return {
        content: JSON.stringify({
          mode: 'background',
          agentId,
          childRunSpecId: childRunSpecId ?? null,
          childSessionId,
          message: 'Agent started in background. Use query_agent with this agentId to check status and retrieve results.',
        }, null, 2),
      };
    }

    // Sync mode (original behavior)
    const childResult = await options.runAgent(request.prompt, {
      sessionId: childSessionId,
      provider: request.provider ?? options.provider,
      model: request.model ?? options.model,
      providerFallback: childOverridesRoute ? undefined : options.providerFallback,
      modelSettings: options.modelSettings,
      runContractMetadata: childRunContractMetadata,
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
      onProviderFallback: options.onProviderFallback,
      architectEditor: options.architectEditor,
      preActionGate: options.preActionGate,
      identity: { name: 'child', level: resolveIdentityLevelForExecutionPath('child-spawned') },
    });

    return {
      content: JSON.stringify({
        mode: 'sync',
        childSessionId: childSessionId,
        childRunSpecId: childRunSpecId ?? null,
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

function normalizeMode(value: unknown): SpawnAgentRequest['mode'] | undefined {
  if (value === 'sync' || value === 'background') return value;
  return undefined;
}

function normalizeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.floor(value);
}
