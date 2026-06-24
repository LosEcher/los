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
import { summarizeModelProfile, type ModelExecutionSummary } from '../model-profiles.js';
import {
  createToolRegistry,
  registerBuiltinTools,
  type ToolRegistry,
} from '../tools/core/registry.js';
import type { MCPServerRegistryRecord } from '../tools/external/mcp-client.js';
import { listMCPServers } from '../mcp-servers.js';
import { createSpawnAgentRunner, registerSpawnAgentTool, type ChildAgentRunner } from '../tools/core/agent-tools.js';
import { createEventEmitter, type SessionEventContext, type SessionEventCallback } from '../event-emitter.js';
import { appendSessionEvent } from '../session-events.js';
import {
  buildInitialMessages,
  getDefaultSystemPrompt,
} from './message-builder.js';
import { resolveAgentIdentity, formatIdentityForPrompt } from '../identity-loader.js';
import {
  resolveAllowedTools,
  resolveToolPolicy,
} from './tool-resolver.js';
import {
  previewText,
} from './utils.js';
import type { Message, Provider, ToolDef } from '../providers/index.js';
import type { AgentConfig } from './types.js';
import type { Logger } from '@los/infra/logger';
import type {
  SessionEventUsage,
} from '../session-events.js';

type EmitEvent = ReturnType<typeof createEventEmitter>;

export interface AgentRunSetup {
  log: Logger;
  provider: Provider;
  modelProfile: ModelExecutionSummary;
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
  const mainProviderName = editorMode
    ? (config.architectEditor!.editorProvider ?? config.provider)
    : config.provider;
  const provider = createProvider(mainProviderName, {
    model: editorMode ? config.architectEditor!.editorModel : config.model,
    traceId: config.traceId,
  });
  const modelProfile = summarizeModelProfile(provider.profile);
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
  const allowedTools = resolveAllowedTools(config.allowedTools, toolMode);
  const sandboxMode = config.sandboxMode ?? 'workspace-write';
  const policy = resolveToolPolicy(toolMode, config.toolRetry, sandboxMode);
  const signal = config.signal;

  // Build initial messages (synchronous; MCP loading happens in async phase)
  const messages = buildInitialMessages(prompt, systemPrompt, config.initialMessages, config.maxContextTokens, config.contextCompression, config.sessionId);

  // Set up tools
  const tools = createToolRegistry({ allowedTools, policy });
  registerSpawnAgentTool(tools, createSpawnAgentRunner({
    runAgent,
    sessionId: config.sessionId,
    provider: config.provider,
    model: config.model,
    modelSettings: config.modelSettings,
    runContractMetadata: config.runContractMetadata,
    workspaceRoot: config.workspaceRoot,
    // AP6: inherit parent trace/request/run-spec for cross-agent correlation
    traceId: config.traceId,
    requestId: config.requestId,
    runSpecId: config.runSpecId,
    architectEditor: config.architectEditor,
    toolRetry: config.toolRetry,
    signal,
    onSessionEvent: config.onSessionEvent,
  }));

  const emitEvent = createEventEmitter(config.sessionId, config, config.onSessionEvent);

  return {
    log,
    provider,
    modelProfile,
    toolMode,
    allowedTools,
    sandboxMode,
    policy,
    signal,
    tools,
    mcpCleanup: async () => {}, // placeholder — replaced by async init
    toolDefs: [], // placeholder — replaced by async init
    toolNames: [], // placeholder — replaced by async init
    emitEvent,
    messages,
    maxLoops,
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
  // Load enabled MCP servers from the persistent registry
  let mcpRegistryRecords: MCPServerRegistryRecord[] | undefined;
  if (config.tenantId || config.projectId) {
    try {
      const registryServers = await listMCPServers({
        tenantId: config.tenantId,
        projectId: config.projectId,
        enabled: true,
      });
      mcpRegistryRecords = registryServers
        .filter(s => s.status !== 'disabled')
        .map(s => ({
          id: s.id,
          command: s.command,
          args: s.args,
          url: s.url,
          env: s.env,
        }));
    } catch (err: any) {
      setup.log.warn(`Failed to load MCP servers from registry: ${err.message ?? String(err)}`);
    }
  }

  // Register builtin tools (includes MCP servers)
  const mcpCleanup = await registerBuiltinTools(setup.tools, {
    workspaceRoot: config.workspaceRoot,
    mcpServers: config.mcpServers,
    mcpRegistryRecords,
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
      requestedProvider: config.provider ?? null,
      requestedModel: config.model ?? null,
      effectiveModel: setup.provider.profile.model,
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
