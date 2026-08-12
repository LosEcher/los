import { randomUUID } from 'node:crypto';
import { getLogger } from '@los/infra/logger';
import { resolveIdentityLevelForExecutionPath } from '../../identity-loader.js';
import { READ_ONLY_BUILTIN_TOOLS } from './registry.js';
import { createRunSpec, ensureRunSpecStore, listCompletedChildRunSpecs, listRunSpecsForSession, updateRunSpecResult, type RunSpecResult } from '../../run-specs.js';
import { appendSessionEvent, ensureSessionEventStore } from '../../session-events.js';
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
  /** Parent session that spawned this background child (for cancel cascade). */
  parentSessionId?: string;
  parentRunSpecId?: string;
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
  /** Set when the agent was recovered from a persisted run_spec after a restart. */
  persisted?: boolean;
  /** Optional lifecycle emitter (parent onSessionEvent). */
  emitLifecycle?: (type: string, payload: Record<string, unknown>) => void;
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

function emitChildLifecycle(agent: TrackedAgent, type: string, extra: Record<string, unknown> = {}): void {
  const payload: Record<string, unknown> = {
    agentId: agent.agentId,
    childSessionId: agent.childSessionId,
    childRunSpecId: agent.childRunSpecId ?? null,
    parentSessionId: agent.parentSessionId ?? null,
    parentRunSpecId: agent.parentRunSpecId ?? null,
    status: agent.status,
    ...extra,
  };
  try {
    agent.emitLifecycle?.(type, payload);
  } catch {
    // In-process callback is best-effort; never break kill/complete paths.
  }
  // Durable audit row on the parent session when available (C1).
  const parentSessionId = agent.parentSessionId;
  if (!parentSessionId) return;
  void (async () => {
    try {
      await ensureSessionEventStore();
      await appendSessionEvent({
        sessionId: parentSessionId,
        type,
        source: 'los.subagent',
        turn: 0,
        payload,
      });
    } catch {
      // DB may be unavailable in unit tests / early boot.
    }
  })();
}

function killAgent(agentId: string, reason = 'aborted'): boolean {
  const agent = trackedAgents.get(agentId);
  if (!agent || agent.status !== 'running') return false;
  agent.abortController.abort();
  agent.status = 'killed';
  agent.error = reason;
  persistAgentResult(agent.childRunSpecId, {
    status: 'failed',
    text: '',
    error: reason,
  });
  emitChildLifecycle(agent, 'child.agent.killed', { reason });
  return true;
}

/**
 * Abort all running background children spawned under a parent session.
 * Used when the parent run signal aborts (C0 cancel cascade).
 */
export function killAgentsForParent(parentSessionId: string, reason = 'parent_cancelled'): number {
  if (!parentSessionId) return 0;
  let killed = 0;
  for (const agent of trackedAgents.values()) {
    if (agent.status === 'running' && agent.parentSessionId === parentSessionId) {
      if (killAgent(agent.agentId, reason)) killed += 1;
    }
  }
  return killed;
}

function listAgents(): TrackedAgent[] {
  return [...trackedAgents.values()];
}

/** Test-only: clear in-memory background tracker (aborts running children first). */
export function _resetTrackedAgentsForTests(): void {
  for (const agent of [...trackedAgents.values()]) {
    if (agent.status === 'running') {
      agent.abortController.abort();
    }
  }
  trackedAgents.clear();
}

// ── Persisted Agent Recovery ───────────────────────────

function agentIdToChildSessionId(agentId: string): string | undefined {
  // agentId format: `agent-${childSessionId}` (see createSpawnAgentRunner)
  return agentId.startsWith('agent-') ? agentId.slice('agent-'.length) : undefined;
}

function trackedFromRunSpec(spec: { id: string; sessionId: string; prompt: string; createdAt: string; result?: RunSpecResult | null }): TrackedAgent {
  const result = spec.result;
  return {
    agentId: `agent-${spec.sessionId}`,
    childRunSpecId: spec.id,
    childSessionId: spec.sessionId,
    status: result?.status === 'failed' ? 'failed' : 'completed',
    startedAt: new Date(spec.createdAt).getTime(),
    prompt: spec.prompt,
    result: result ? {
      text: result.text,
      loopCount: result.loopCount ?? 0,
      totalTokens: result.totalTokens ?? 0,
    } : undefined,
    error: result?.error,
    abortController: new AbortController(), // no-op after restart
    persisted: true,
  };
}

/**
 * Recover a background subagent from durable run_spec state after a process
 * restart. Returns:
 * - { kind: 'persisted', agent } when the result was persisted before shutdown
 * - { kind: 'lost', prompt } when the run_spec exists but no result was persisted
 * - undefined when no run_spec exists for this agentId
 */
async function resolvePersistedAgent(agentId: string, scope?: { tenantId?: string; projectId?: string }): Promise<
  { kind: 'persisted'; agent: TrackedAgent } | { kind: 'lost'; prompt: string } | undefined
> {
  const childSessionId = agentIdToChildSessionId(agentId);
  if (!childSessionId) return undefined;
  try {
    await ensureRunSpecStore();
    const specs = await listRunSpecsForSession(childSessionId, 1, scope);
    const spec = specs[0];
    if (!spec) return undefined;
    if (!spec.result) return { kind: 'lost', prompt: spec.prompt };
    return { kind: 'persisted', agent: trackedFromRunSpec(spec) };
  } catch {
    return undefined;
  }
}

/**
 * Fire-and-forget persistence of a background subagent result onto its child
 * run_spec. Never rejects — the tool result must not depend on DB availability.
 */
function persistAgentResult(runSpecId: string | undefined, result: Omit<RunSpecResult, 'completedAt'>): void {
  if (!runSpecId) return;
  void updateRunSpecResult(runSpecId, { ...result, completedAt: new Date().toISOString() })
    .catch(() => undefined);
}

async function listPersistedAgents(limit = 20, scope?: { tenantId?: string; projectId?: string }): Promise<TrackedAgent[]> {
  try {
    await ensureRunSpecStore();
    const specs = await listCompletedChildRunSpecs(limit, scope);
    return specs.map(trackedFromRunSpec);
  } catch {
    return [];
  }
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
    // L0 so read-only mode (maxRiskLevel L0) can spawn read-only children;
    // sideEffect stays true so the tool is never replayed on retry. The child
    // inherits read-only tools and cannot spawn further agents.
    riskLevel: 'L0',
    permissions: ['agent:spawn'],
    timeoutMs: 600_000,
    retryable: false,
    idempotent: false,
    costLevel: 'high',
    sideEffect: true,
    tags: ['agent', 'subagent'],
  });
}

export function registerAgentQueryKillTools(registry: ToolRegistry, options: { tenantId?: string; projectId?: string } = {}): void {
  const scope = { tenantId: options.tenantId, projectId: options.projectId };
  registry.register('query_agent', async (args) => {
    const agentId = normalizeString(args.agentId);
    if (!agentId) return { content: '', error: 'agentId is required' };
    const agent = getAgent(agentId);
    if (agent) {
      return {
        content: JSON.stringify({
          source: 'live',
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
    }
    // Memory miss: recover from durable run_spec state (process may have restarted).
    const persisted = await resolvePersistedAgent(agentId, scope);
    if (persisted?.kind === 'persisted') {
      const a = persisted.agent;
      return {
        content: JSON.stringify({
          source: 'persisted',
          agentId: a.agentId,
          childRunSpecId: a.childRunSpecId ?? null,
          childSessionId: a.childSessionId,
          status: a.status,
          startedAt: new Date(a.startedAt).toISOString(),
          prompt: a.prompt,
          result: a.result ?? null,
          error: a.error ?? null,
        }, null, 2),
      };
    }
    if (persisted?.kind === 'lost') {
      return {
        content: JSON.stringify({
          agentId,
          status: 'unknown',
          message: 'Background agent ran in a previous process and shut down before its result was persisted. Re-run spawn_agent if the output is still needed.',
          prompt: persisted.prompt,
        }, null, 2),
      };
    }
    return { content: '', error: `Agent not found: ${agentId}` };
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
    const live = listAgents();
    const persisted = await listPersistedAgents(20, scope);
    // Live state wins over persisted recovery entries with the same agentId.
    const merged = new Map<string, TrackedAgent>();
    for (const a of persisted) merged.set(a.agentId, a);
    for (const a of live) merged.set(a.agentId, a);
    return {
      content: JSON.stringify([...merged.values()].map(a => ({
        agentId: a.agentId,
        childRunSpecId: a.childRunSpecId ?? null,
        status: a.status,
        prompt: a.prompt.slice(0, 120),
        startedAt: new Date(a.startedAt).toISOString(),
        source: a.persisted ? 'persisted' : 'live',
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
  let clone: SpawnAgentRunnerOptions['runContractMetadata'];
  try {
    clone = structuredClone(parent);
  } catch {
    clone = JSON.parse(JSON.stringify(parent)) as SpawnAgentRunnerOptions['runContractMetadata'];
  }
  // Runtime scheduler details (execution-kernel selection and route state)
  // are parent-run metadata written during execution. Children must not
  // inherit them: a partial executionKernel object fails run-spec contract
  // validation, and route/kernel choices are re-resolved for the child.
  if (clone && typeof clone === 'object') {
    const { executionKernel: _kernel, requestedExecutionKernel: _requestedKernel, ...rest } = clone as Record<string, unknown>;
    clone = rest as SpawnAgentRunnerOptions['runContractMetadata'];
  }
  return clone;
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
    } catch (error) {
      // Durable lineage is best-effort: the child still runs, but without a
      // run_spec it cannot be recovered after a restart. Log loudly so the
      // gap is visible instead of silently swallowed.
      const contractKeys = childRunContractMetadata ? Object.keys(childRunContractMetadata).join(',') : '(none)';
      const runContractKeys = (childRunContractMetadata?.runContract && typeof childRunContractMetadata.runContract === 'object')
        ? Object.keys(childRunContractMetadata.runContract).join(',')
        : '(none)';
      getLogger('agent-tools').warn(
        `child run_spec persistence failed; child will not survive restart: ${error instanceof Error ? error.message : String(error)} [contractKeys=${contractKeys} runContractKeys=${runContractKeys}]`,
        { childSessionId },
      );
      childRunSpecId = undefined;
    }

    // Background mode: fire-and-forget with AbortController
    if (isBackground) {
      const abortController = new AbortController();
      const agentId = `agent-${childSessionId}`;
      const parentSessionId = options.sessionId;
      const lifecycleEmit = options.onSessionEvent
        ? (type: string, payload: Record<string, unknown>) => {
            void options.onSessionEvent?.({
              id: 0,
              sessionId: parentSessionId ?? childSessionId,
              turn: 0,
              type,
              source: 'los.subagent',
              payload,
              visibility: 'audit',
              createdAt: new Date().toISOString(),
              requestId: options.requestId,
              traceId: options.traceId,
              tenantId: options.tenantId,
              projectId: options.projectId,
            });
          }
        : undefined;

      const tracked: TrackedAgent = {
        agentId,
        childRunSpecId,
        childSessionId,
        parentSessionId,
        parentRunSpecId: options.runSpecId,
        status: 'running',
        startedAt: Date.now(),
        prompt: request.prompt,
        abortController,
        emitLifecycle: lifecycleEmit,
      };
      trackAgent(tracked);

      // C0: parent abort cascades to background children (do not orphan work).
      const parentSignal = options.signal;
      const onParentAbort = () => {
        killAgent(agentId, 'parent_cancelled');
      };
      if (parentSignal) {
        if (parentSignal.aborted) {
          killAgent(agentId, 'parent_cancelled');
          return {
            content: JSON.stringify({
              mode: 'background',
              agentId,
              childRunSpecId: childRunSpecId ?? null,
              childSessionId,
              status: 'killed',
              message: 'Parent already cancelled; background agent was not started.',
            }, null, 2),
          };
        }
        parentSignal.addEventListener('abort', onParentAbort, { once: true });
      }

      emitChildLifecycle(tracked, 'child.agent.started', { mode: 'background' });

      // Fire and forget — result is stored on the tracked agent and persisted
      // to the child run_spec so it survives a process restart.
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
        parentSignal?.removeEventListener('abort', onParentAbort);
        const agent = getAgent(agentId);
        if (!agent || agent.status === 'killed') return;
        agent.status = 'completed';
        agent.result = {
          text: result.text,
          loopCount: result.loopCount,
          totalTokens: result.totalTokens.prompt + result.totalTokens.completion,
        };
        persistAgentResult(childRunSpecId, {
          status: 'completed',
          text: result.text,
          loopCount: result.loopCount,
          totalTokens: result.totalTokens.prompt + result.totalTokens.completion,
        });
        emitChildLifecycle(agent, 'child.agent.completed', {
          loopCount: result.loopCount,
          totalTokens: result.totalTokens.prompt + result.totalTokens.completion,
        });
        // Schedule cleanup after completion
        setTimeout(() => trackedAgents.delete(agentId), 300_000).unref();
      }).catch(err => {
        parentSignal?.removeEventListener('abort', onParentAbort);
        const agent = getAgent(agentId);
        if (!agent || agent.status === 'killed') return;
        agent.status = 'failed';
        agent.error = err instanceof Error ? err.message : String(err);
        persistAgentResult(childRunSpecId, {
          status: 'failed',
          text: '',
          error: err instanceof Error ? err.message : String(err),
        });
        emitChildLifecycle(agent, 'child.agent.failed', { error: agent.error });
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
