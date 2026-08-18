/**
 * @los/agent/loop/setup — Agent run setup phase.
 *
 * Extracted from loop.ts to keep the main loop under the 400-line CI warning
 * threshold. Handles: provider creation, identity resolution, system prompt
 * composition, MCP server loading, tool registry creation, spawn agent
 * registration, event emitter setup, message building, and session.started
 * event emission.
 */

import { getLogger } from '@los/infra/logger';
import { createProvider } from '../providers/index.js';
import {
  createProviderFallbackRouter,
  prepareProviderFallbackPolicy,
  resolveProviderFallbackInitialTarget,
  type ProviderFallbackEvent,
} from '../providers/provider-fallback.js';
import { getCachedHealthScore, isUnhealthy } from '../providers/provider-health.js';
import { resolveModelRouteDecision, type ModelRouteDecision } from '../providers/model-routing.js';
import { listLatestProviderCompatEvidence } from '../provider-compat-evidence.js';
import { summarizeModelProfile, type ModelExecutionSummary } from '../model-profiles.js';
import {
  createToolRegistry,
  registerBuiltinTools,
  type ToolRegistry,
} from '../tools/core/registry.js';
import { createDeferredRegistry } from '../tools/core/deferred-registry.js';
import type { MCPServerRegistryRecord } from '../tools/external/mcp-client.js';
import { listMCPServers } from '../mcp-servers.js';
import { mcpServerExecutionBlocker } from '../mcp-distribution-policy.js';
import { resolveMCPCredentialRef } from '../mcp-credential-resolver.js';
import { createSpawnAgentRunner, registerSpawnAgentTool, registerAgentQueryKillTools, type ChildAgentRunner } from '../tools/core/agent-tools.js';
import { createEventEmitter, type SessionEventContext, type SessionEventCallback } from '../event-emitter.js';
import { appendSessionEvent } from '../session-events.js';
import {
  loadPreActionEvidence,
  mergePreActionEvidence,
} from '../pre-action-evidence.js';
import {
  preActionGateConfigFromAgentOptions,
  type PreActionGateConfig,
} from '../pre-action-gate.js';
import { buildInitialMessages, getDefaultSystemPrompt } from './message-builder.js';
import { resolveAgentIdentity, formatIdentityForPrompt } from '../identity-loader.js';
import { resolveAllowedTools, resolveToolPolicy } from './tool-resolver.js';
import {
  previewText,
} from './utils.js';
import { resolveAgentRunProviderModelSelection } from './provider-selection.js';
import type { Message, Provider, ToolDef } from '../providers/index.js';
import type { AgentConfig } from './types.js';
import type { Logger } from '@los/infra/logger';
import type {
  SessionEventUsage,
} from '../session-events.js';
import { registerPlanningSubmissionTool, type PlanningSubmissionCollector } from '../planning-submission-tool.js';

type EmitEvent = ReturnType<typeof createEventEmitter>;

export interface AgentRunSetup {
  log: Logger;
  provider: Provider;
  modelProfile: ModelExecutionSummary;
  modelRoute: ModelRouteDecision;
  toolMode: 'all' | 'project-write' | 'read-only';
  allowedTools: readonly string[] | undefined;
  sandboxMode: 'readonly' | 'workspace-write' | 'sandbox';
  policy: ReturnType<typeof resolveToolPolicy>;
  signal: AbortSignal | undefined;
  tools: ToolRegistry;
  mcpCleanup: () => Promise<void>;
  toolDefs: ToolDef[];
  toolNames: string[];
  emitEvent: EmitEvent;
  messages: Message[];
  maxLoops: number;
  preActionGateConfig: PreActionGateConfig | undefined;
  planningSubmissionCollector?: PlanningSubmissionCollector;
  counters: {
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalCacheHitTokens: number;
    totalCacheMissTokens: number;
    totalCostUsd: number;
    cacheEventCount: number;
  };
}

function identityBlockFromConfig(config: AgentConfig): string | undefined {
  if (config.identity?.level === 'none') return undefined;
  const agentName = config.identity?.name ?? 'default';
  try {
    const ws = config.workspaceRoot ?? process.cwd();
    const id = resolveAgentIdentity(agentName, ws);
    return formatIdentityForPrompt(id, config.identity?.level ?? 'standard');
  } catch {
    // Identity resolution is best-effort; proceed without identity block
    return undefined;
  }
}

/**
 * Synchronous phase of agent run setup. Returns a partially-initialized
 * struct; call {@link completeAgentSetup} to perform the async parts
 * (MCP loading, builtin registration, spawn agent wiring, event emission).
 *
 * The `runAgent` callback is passed separately to avoid a circular import
 * between setup.ts and loop.ts.
 */
export function setupAgentRun(
  prompt: string,
  config: AgentConfig,
  runAgent: ChildAgentRunner,
): AgentRunSetup {
  const log = config.log ?? getLogger('agent');
  const maxLoops = config.maxLoops ?? 20;
  // In architect-editor mode the main ReAct loop IS the editor. The architect
  // runs as a separate front-matter phase (see loop/architect-phase.ts) before
  // this loop starts, so resolve the editor provider + editor system prompt.
  const editorMode = config.architectEditor?.enabled === true;
  const requestedProvider = editorMode
    ? (config.architectEditor?.editorProvider ?? config.provider)
    : config.provider;
  const requestedModel = editorMode
    ? (config.architectEditor?.editorModel ?? config.model)
    : config.model;
  const fallbackInitialTarget = resolveProviderFallbackInitialTarget(config.providerFallback, {
    provider: requestedProvider,
    model: requestedModel,
  });
  const providerSelection = resolveAgentRunProviderModelSelection({
    ...config,
    provider: fallbackInitialTarget?.provider ?? config.provider,
    model: fallbackInitialTarget?.model ?? config.model,
  });
  const architectEditorOverride = providerSelection.source === 'architect_editor_override';
  const provider = createProvider(providerSelection.provider, {
    model: providerSelection.model,
    traceId: config.traceId,
  });
  const modelProfile = summarizeModelProfile(provider.profile);
  const modelRoute = resolveModelRouteDecision({
    requestedProvider: providerSelection.provider,
    requestedModel: providerSelection.model,
    effectiveProvider: provider.name,
    effectiveModel: provider.profile.model,
    architectEditorOverride,
    explicitFallbackPolicy: Boolean(fallbackInitialTarget),
  });
  const toolMode = config.toolMode ?? 'project-write';

  // Resolve system prompt. When explicitly provided, use as-is.
  // In architect-editor mode the main loop uses the editor prompt; the architect
  // prompt is applied inside the architect phase, not here.
  let systemPrompt = config.systemPrompt;
  if (!systemPrompt) {
    const identityBlock = identityBlockFromConfig(config);
    const initialPromptToolMode = editorMode ? 'editor' as const : toolMode;
    systemPrompt = getDefaultSystemPrompt(initialPromptToolMode, identityBlock || undefined);
  }
  const allowedTools = resolveAllowedTools(config.allowedTools, toolMode, config.planningTransport);
  const sandboxMode = config.sandboxMode ?? 'workspace-write';
  const policy = resolveToolPolicy(toolMode, config.toolRetry, sandboxMode);
  const signal = config.signal;

  // Inject provider context window into compression config so large-window
  // providers (Kimi-K3 1M, Gemini 2.5 Pro, etc.) trigger compression at
  // absolute token budgets (300K / 500K / 750K) instead of percentage ratios.
  const effectiveMaxContextTokens = config.maxContextTokens
    ?? provider.profile.recommendedCompressionTokens;
  const effectiveCompression = config.contextCompression && {
    ...config.contextCompression,
    providerContextWindow: provider.profile.maxInputTokens,
  };

  // Build initial messages (synchronous; MCP loading happens in async phase)
  const messages = buildInitialMessages(prompt, systemPrompt, config.initialMessages, effectiveMaxContextTokens, effectiveCompression);

  // Set up tools
  const tools = createToolRegistry({ allowedTools, policy });
  const deferredTools = config.deferredToolLoading?.mode === 'name-only'
    ? createDeferredRegistry(tools, config.deferredToolLoading)
    : undefined;
  const planningSubmissionCollector = config.planningTransport === 'typed_tool'
    ? registerPlanningSubmissionTool(tools, config.runContractMetadata)
    : undefined;
  registerSpawnAgentTool(tools, createSpawnAgentRunner({
    runAgent,
    sessionId: config.sessionId,
    provider: config.provider,
    model: config.model,
    providerFallback: config.providerFallback,
    modelSettings: config.modelSettings,
    runContractMetadata: config.runContractMetadata,
    workspaceRoot: config.workspaceRoot,
    parentToolMode: config.toolMode,
    // AP6: inherit parent trace/request/run-spec for cross-agent correlation
    traceId: config.traceId,
    requestId: config.requestId,
    runSpecId: config.runSpecId,
    tenantId: config.tenantId,
    projectId: config.projectId,
    architectEditor: config.architectEditor,
    preActionGate: config.preActionGate,
    toolRetry: config.toolRetry,
    signal,
    onSessionEvent: config.onSessionEvent,
    onProviderFallback: config.onProviderFallback,
  }));

  // Register background agent query/kill/list tools
  registerAgentQueryKillTools(tools, { tenantId: config.tenantId, projectId: config.projectId });

  const emitEvent = createEventEmitter(config.sessionId, config, config.onSessionEvent);

  return {
    log,
    provider,
    modelProfile,
    modelRoute,
    toolMode,
    allowedTools,
    sandboxMode,
    policy,
    signal,
    tools: deferredTools ?? tools,
    mcpCleanup: async () => {}, // placeholder — replaced by async init
    toolDefs: [], // placeholder — replaced by async init
    toolNames: [], // placeholder — replaced by async init
    emitEvent,
    messages,
    maxLoops,
    preActionGateConfig: preActionGateConfigFromAgentOptions(config.preActionGate),
    planningSubmissionCollector,
    counters: {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalCacheHitTokens: 0,
      totalCacheMissTokens: 0,
      totalCostUsd: 0,
      cacheEventCount: 0,
    },
  };
}

/**
 * Completes the async part of agent run setup: loads MCP servers,
 * registers builtin tools, finalizes toolDefs/toolNames, and emits
 * session.started + tool.catalog events.
 *
 * Returns the updated setup with mcpCleanup and toolDefs/toolNames populated.
 */
export async function completeAgentSetup(
  prompt: string,
  config: AgentConfig,
  setup: AgentRunSetup,
): Promise<AgentRunSetup> {
  await _applyProviderFallbackToSetup(config, setup);

  if (setup.preActionGateConfig && config.preActionGate?.loadPersistedEvidence !== false &&
      (config.sessionId || config.projectId)) {
    try {
      const persistedEvidence = await loadPreActionEvidence({
        sessionId: config.sessionId,
        tenantId: config.tenantId,
        projectId: config.projectId,
      });
      mergePreActionEvidence(setup.preActionGateConfig, persistedEvidence);
    } catch (err: any) {
      setup.log.warn(`Failed to load pre-action evidence: ${err.message ?? String(err)}`);
    }
  }

  // Load enabled MCP servers from the persistent registry
  let mcpRegistryRecords: MCPServerRegistryRecord[] | undefined;
  if (config.tenantId || config.projectId) {
    try {
      const registryServers = await listMCPServers({
        tenantId: config.tenantId,
        projectId: config.projectId,
        enabled: true,
      });
      const resolvedRecords: MCPServerRegistryRecord[] = [];
      for (const server of registryServers) {
        const blocker = mcpServerExecutionBlocker(server);
        if (blocker) {
          setup.log.warn(`Skipping MCP server [${server.id}]: ${blocker}`);
          continue;
        }
        const resolved = await resolveMCPCredentialRef(server.authConfig, {
          serverId: server.id,
          transport: server.transport,
        });
        if (!resolved.ok) {
          setup.log.warn(`Skipping MCP server [${server.id}]: ${resolved.reason}`);
          continue;
        }
        resolvedRecords.push({
          id: server.id,
          command: server.command,
          args: server.args,
          url: server.url,
          transport: server.transport as 'stdio' | 'sse' | 'streamable-http' | undefined,
          headers: { ...(server.headers ?? {}), ...resolved.headers },
          env: { ...server.env, ...resolved.env },
          toolPolicy: server.toolPolicy,
          adapterConfig: server.adapterConfig,
        });
      }
      mcpRegistryRecords = resolvedRecords;
    } catch (err: any) {
      setup.log.warn(`Failed to load MCP servers from registry: ${err.message ?? String(err)}`);
    }
  }

  // Register builtin tools (includes MCP servers)
  const mcpCleanup = await registerBuiltinTools(setup.tools, {
    workspaceRoot: config.workspaceRoot,
    mcpServers: config.mcpServers,
    mcpRegistryRecords,
    taskRunId: config.taskRunId,
    dispatchId: config.dispatchId,
    sessionId: config.sessionId,
    runSpecId: config.runSpecId,
  });
  setup.mcpCleanup = mcpCleanup;

  const toolDefs = setup.tools.getDefinitions();
  const toolNames = setup.tools.list();
  setup.toolDefs = toolDefs;
  setup.toolNames = toolNames;

  // Emit session.started event
  setup.log.info(`Agent starting — maxLoops=${setup.maxLoops}, provider=${setup.provider.name}`);
  await setup.emitEvent({
    type: 'session.started',
    payload: {
      promptPreview: previewText(prompt),
      promptLength: prompt.length,
      provider: setup.provider.name,
      requestedProvider: setup.modelRoute.requestedProvider ?? null,
      requestedModel: setup.modelRoute.requestedModel ?? null,
      effectiveProvider: setup.modelRoute.effectiveProvider,
      effectiveModel: setup.modelRoute.effectiveModel,
      routeReason: setup.modelRoute.reason,
      modelProfile: setup.modelProfile,
      workspaceRoot: config.workspaceRoot ?? null,
      toolMode: setup.toolMode,
      allowedTools: setup.allowedTools,
      toolPolicy: setup.policy,
      maxLoops: setup.maxLoops,
      modelSettings: config.modelSettings ?? null,
    },
  });
  await setup.emitEvent({
    type: 'tool.catalog',
    payload: {
      count: toolNames.length,
      tools: toolNames,
    },
  });

  return setup;
}

export async function _applyProviderFallbackToSetup(
  config: AgentConfig,
  setup: AgentRunSetup,
  dependencies: {
    loadEvidence?: typeof listLatestProviderCompatEvidence;
    createProvider?: typeof createProvider;
  } = {},
): Promise<void> {
  if (!config.providerFallback) return;
  const evidence = await (dependencies.loadEvidence ?? listLatestProviderCompatEvidence)();
  const prepared = prepareProviderFallbackPolicy(config.providerFallback, evidence);
  if (!prepared) return;
  const providerFactory = dependencies.createProvider ?? createProvider;
  setup.provider = createProviderFallbackRouter({
    prepared,
    initialProvider: setup.provider,
    createProvider: providerFactory,
    traceId: config.traceId,
    shouldSkipTarget: target => {
      const score = getCachedHealthScore(target.provider);
      return Boolean(score && isUnhealthy(score));
    },
    onEvent: async event => {
      await emitProviderFallbackEvent(setup.emitEvent, event);
      await config.onProviderFallback?.(event);
    },
  });
  config.log?.info?.(
    `provider fallback applied: ${setup.provider.name} -> ${prepared.policy.targets.map(target => target.provider).join(' -> ')} (session=${config.sessionId ?? '?'})`,
  );
}

async function emitProviderFallbackEvent(
  emitEvent: EmitEvent,
  event: ProviderFallbackEvent,
): Promise<void> {
  if (event.type === 'selected') {
    await emitEvent({
      type: 'provider.fallback.selected',
      turn: event.callIndex,
      model: event.toModel,
      payload: {
        policyMode: 'explicit_ordered',
        callIndex: event.callIndex,
        switchIndex: event.switchIndex,
        failureClass: event.failureClass,
        errorCode: event.errorCode ?? null,
        errorMessage: event.errorMessage,
        fromProvider: event.fromProvider,
        fromModel: event.fromModel,
        toProvider: event.toProvider,
        toModel: event.toModel,
        compatibilityEvidenceId: event.compatibilityEvidenceId ?? null,
      },
    });
    return;
  }
  await emitEvent({
    type: 'provider.fallback.exhausted',
    turn: event.callIndex,
    model: event.fromModel,
    payload: {
      policyMode: 'explicit_ordered',
      callIndex: event.callIndex,
      switchCount: event.switchIndex,
      failureClass: event.failureClass,
      errorCode: event.errorCode ?? null,
      errorMessage: event.errorMessage,
      provider: event.fromProvider,
      model: event.fromModel,
    },
  });
}
