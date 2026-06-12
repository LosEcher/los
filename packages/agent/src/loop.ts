/**
 * @los/agent/loop — ReAct agent execution loop.
 *
 * Inspired by pi's agent-core and Codex's exec mode.
 * Flow: user prompt → build messages → LLM call → tool execution → loop → text response.
 */

import { getLogger } from '@los/infra/logger';
import { createProvider, type Message, type ToolCall } from './providers/index.js';
import { summarizeModelProfile, estimateCost, type CostEstimate } from './model-profiles.js';
import { runPreExecutionPhases } from './loop/phases.js';
import { applyPhaseGate } from './loop/phase-tool-gate.js';
import {
  createToolRegistry,
  registerBuiltinTools,
  type ToolRegistry,
} from './tools/registry.js';
import type { MCPServerRegistryRecord } from './tools/mcp-client.js';
import { listMCPServers } from './mcp-servers.js';
import { createSpawnAgentRunner, registerSpawnAgentTool } from './tools/agent-tools.js';
import {
  type SessionEventUsage,
} from './session-events.js';
import { createEventEmitter } from './event-emitter.js';
import {
  buildInitialMessages,
  getDefaultSystemPrompt,
} from './loop/message-builder.js';
import {
  compressOrTrimMessages,
  generateCompressionSummary,
  summarizeText,
  summarizeToolCallsForCompression,
} from './loop/compression.js';
import {
  estimateTokens,
  estimateMessageTokens,
  trimMessagesToBudget,
  truncateContent,
} from './loop/token-utils.js';
import {
  resolveAllowedTools,
  resolveToolPolicy,
} from './loop/tool-resolver.js';
import {
  inferToolSource,
  normalizeUsage,
  inferCacheHit,
  summarizeToolCalls,
  previewText,
  summarizeCapability,
  assertNotAborted,
  withAbort,
  abortErrorFromSignal,
  summarizeSessionErrors,
} from './loop/utils.js';
import type {
  AgentConfig,
  AgentModelDelta,
  AgentResult,
  CheckpointState,
  ContextCompressionConfig,
  ToolCallStateTransition,
  TurnSummary,
} from './loop/types.js';

const log = getLogger('agent');

export type {
  AgentConfig,
  AgentModelDelta,
  AgentResult,
  CheckpointState,
  ContextCompressionConfig,
  ToolCallStateTransition,
  TurnSummary,
} from './loop/types.js';

// ── Core Loop ───────────────────────────────────────────

export async function runAgent(
  prompt: string,
  config: AgentConfig = {},
): Promise<AgentResult> {
  const log = config.log ?? getLogger('agent');
  const maxLoops = config.maxLoops ?? 20;
  const provider = createProvider(config.provider, { model: config.model, traceId: config.traceId });
  const modelProfile = summarizeModelProfile(provider.profile);
  const toolMode = config.toolMode ?? 'project-write';
  const systemPrompt = config.systemPrompt ?? getDefaultSystemPrompt(toolMode);
  const allowedTools = resolveAllowedTools(config.allowedTools, toolMode);
  const policy = resolveToolPolicy(toolMode, config.toolRetry);
  const signal = config.signal;

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
      log.warn(`Failed to load MCP servers from registry: ${err.message ?? String(err)}`);
    }
  }

  // Set up tools
  const tools = createToolRegistry({ allowedTools, policy });
  const mcpCleanup = await registerBuiltinTools(tools, {
    workspaceRoot: config.workspaceRoot,
    mcpServers: config.mcpServers,
    mcpRegistryRecords,
  });
  registerSpawnAgentTool(tools, createSpawnAgentRunner({
    runAgent,
    sessionId: config.sessionId,
    provider: config.provider,
    model: config.model,
    modelSettings: config.modelSettings,
    workspaceRoot: config.workspaceRoot,
    toolRetry: config.toolRetry,
    signal,
    onSessionEvent: config.onSessionEvent,
  }));

  const toolDefs = tools.getDefinitions();
  const toolNames = tools.list();
  const emitEvent = createEventEmitter(config.sessionId, config, config.onSessionEvent);

  // Build initial messages
  const messages = buildInitialMessages(prompt, systemPrompt, config.initialMessages, config.maxContextTokens, config.contextCompression);

  const turns: TurnSummary[] = [];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCacheHitTokens = 0;
  let totalCacheMissTokens = 0;
  let totalCostUsd = 0;
  let cacheEventCount = 0;
  const sessionErrors: Array<{ turn: number; type: string; toolName?: string; message: string }> = [];

  log.info(`Agent starting — maxLoops=${maxLoops}, provider=${provider.name}`);
  await emitEvent({
    type: 'session.started',
    payload: {
      promptPreview: previewText(prompt),
      promptLength: prompt.length,
      provider: provider.name,
      requestedProvider: config.provider ?? null,
      requestedModel: config.model ?? null,
      effectiveModel: provider.profile.model,
      modelProfile,
      workspaceRoot: config.workspaceRoot ?? null,
      toolMode,
      allowedTools,
      toolPolicy: policy,
      maxLoops,
      modelSettings: config.modelSettings ?? null,
    },
  });
  await emitEvent({
    type: 'tool.catalog',
    payload: {
      count: toolNames.length,
      tools: toolNames,
    },
  });

  // B1: Optional pre-execution discovery and planning turns.
  // These are guided model turns that produce structured outputs.
  // Enforcement (B0) is in the scheduler, not here.
  const phaseResult = await runPreExecutionPhases(
    config.runContractMetadata ?? {},
    {
      provider,
      emitEvent,
      messages,
      toolDefs,
      signal,
      toolMode,
      modelSettings: config.modelSettings,
    },
  );
  if (phaseResult) return phaseResult;

  try {
    for (let i = 0; i < maxLoops; i++) {
    assertNotAborted(signal);
    log.debug(`Turn ${i + 1}/${maxLoops}`);
    await emitEvent({
      type: 'model.turn.started',
      turn: i + 1,
      model: provider.name,
      payload: {
        provider: provider.name,
        modelProfile,
        messageCount: messages.length,
        offeredToolCount: toolDefs.length,
      },
    });

    const modelStartedAt = Date.now();
    const res = await withAbort(
      provider.chat(messages, toolDefs.length > 0 ? toolDefs : undefined, {
        signal,
        traceId: config.traceId,
        sessionId: config.sessionId,
        modelSettings: config.modelSettings,
        onDelta: config.onModelDelta
          ? async (delta) => {
              await config.onModelDelta?.({ ...delta, turn: i + 1, provider: provider.name });
            }
          : undefined,
      }),
      signal,
    );
    const modelDurationMs = Date.now() - modelStartedAt;
    assertNotAborted(signal);

    totalPromptTokens += res.usage.promptTokens;
    totalCompletionTokens += res.usage.completionTokens;
    totalCacheHitTokens += res.usage.cacheHitTokens ?? 0;
    totalCacheMissTokens += res.usage.cacheMissTokens ?? 0;

    // Cost estimation
    const turnCost = estimateCost({
      promptTokens: res.usage.promptTokens,
      completionTokens: res.usage.completionTokens,
      cacheHitTokens: res.usage.cacheHitTokens,
      cacheMissTokens: res.usage.cacheMissTokens,
    }, provider.profile);
    if (turnCost) totalCostUsd += turnCost.totalCostUsd;

    await emitEvent({
      type: 'model.response',
      turn: i + 1,
      model: res.model,
      cacheHit: inferCacheHit(res.usage),
      usage: normalizeUsage(res.usage),
      payload: {
        provider: provider.name,
        modelProfile,
        durationMs: modelDurationMs,
        textPreview: previewText(res.text),
        textLength: res.text.length,
        reasoningPreview: res.reasoningContent ? previewText(res.reasoningContent) : undefined,
        reasoningLength: res.reasoningContent?.length ?? 0,
        toolCallCount: res.toolCalls.length,
        toolCalls: summarizeToolCalls(res.toolCalls),
        cost: turnCost ?? undefined,
        transport: provider.profile.transportHints?.[0] ?? 'http-stream',
      },
    });

    // Emit model.cache event when cache activity is detected
    if ((res.usage.cacheHitTokens ?? 0) > 0 || (res.usage.cacheMissTokens ?? 0) > 0) {
      cacheEventCount++;
      await emitEvent({
        type: 'model.cache',
        turn: i + 1,
        model: res.model,
        cacheHit: inferCacheHit(res.usage),
        payload: {
          cacheHitTokens: res.usage.cacheHitTokens ?? 0,
          cacheMissTokens: res.usage.cacheMissTokens ?? 0,
          cacheHit: (res.usage.cacheHitTokens ?? 0) > 0,
          estimatedSavingsUsd: turnCost?.cacheSavingsUsd ?? 0,
        },
      });
    }

    // Add assistant message
    const assistantMsg: Message = {
      role: 'assistant',
      content: res.text,
      tool_calls: res.toolCalls.length > 0 ? res.toolCalls : undefined,
    };
    messages.push(assistantMsg);

    // If no tool calls, we're done
    if (res.toolCalls.length === 0) {
      const turn: TurnSummary = {
        loopCount: i + 1,
        text: res.text,
        toolCalls: [],
        toolResults: [],
        reasoningContent: res.reasoningContent,
      };
      turns.push(turn);
      await config.onTurn?.(turn);
      await config.onCheckpoint?.({ messages: [...messages], turns: [...turns] });

      log.info(`Agent finished — ${i + 1} turns, ${totalPromptTokens + totalCompletionTokens} tokens`);
      await emitEvent({
        type: 'session.completed',
        turn: i + 1,
        payload: {
          loopCount: i + 1,
          totalTokens: totalPromptTokens + totalCompletionTokens,
          totalPromptTokens,
          totalCompletionTokens,
          totalCacheHitTokens,
          totalCacheMissTokens,
          totalCostUsd: totalCostUsd > 0 ? totalCostUsd : undefined,
          cacheEventCount,
          errorSummary: sessionErrors.length > 0 ? summarizeSessionErrors(sessionErrors) : undefined,
        },
      });
      return {
        text: res.text,
        turns,
        loopCount: i + 1,
        totalTokens: { prompt: totalPromptTokens, completion: totalCompletionTokens },
        messages,
      };
    }

    // Execute tool calls
    const toolResults: string[] = [];
    for (const tc of res.toolCalls) {
      assertNotAborted(signal);
      const fn = tc.function;
      log.debug(`Tool call: ${fn.name}(${fn.arguments.slice(0, 100)})`);

      // Emit tool.repair if provider repaired malformed arguments
      if (tc._repair?.repaired) {
        await emitEvent({
          type: 'tool.repair',
          turn: i + 1,
          toolName: fn.name,
          payload: {
            callId: tc.id,
            repairSteps: tc._repair.repairSteps ?? [],
          },
        });
        // Track as session error (non-fatal, but worth noting)
        sessionErrors.push({
          turn: i + 1,
          type: 'tool_repair',
          toolName: fn.name,
          message: `Repaired tool call arguments for ${fn.name}: ${(tc._repair.repairSteps ?? []).join(', ')}`,
        });
      }

      let args: Record<string, unknown>;
      try {
        // Graceful fallback for empty arguments (e.g. from split tool call repair)
        args = fn.arguments ? JSON.parse(fn.arguments) as Record<string, unknown> : {};
      } catch (err: any) {
        sessionErrors.push({
          turn: i + 1,
          type: 'tool_parse_error',
          toolName: fn.name,
          message: `Failed to parse tool arguments: ${err?.message ?? String(err)}`,
        });
        await emitEvent({
          type: 'tool.result',
          turn: i + 1,
          toolName: fn.name,
          parentEventId: undefined,
          payload: {
            callId: tc.id,
            ok: false,
            durationMs: 0,
            contentPreview: '',
            contentLength: 0,
            errorPreview: `Invalid tool arguments: ${err?.message ?? String(err)}`,
          },
        });
        throw err;
      }
      const capability = tools.getCapability(fn.name);
      const toolSource = inferToolSource(capability);
      await config.onToolCall?.(tc.id, fn.name, args, i + 1);

      await config.onToolCallState?.({
        callId: tc.id,
        toolName: fn.name,
        state: 'requested',
        turn: i + 1,
        input: args,
        maxAttempts: capability?.retryable ? policy.retry?.maxAttempts : 1,
        idempotent: capability?.idempotent ?? false,
        retryPolicy: policy.retry,
      });

      const callEvent = await emitEvent({
        type: 'tool.call',
        turn: i + 1,
        toolName: fn.name,
        payload: {
          callId: tc.id,
          args,
          argsLength: fn.arguments.length,
          source: toolSource,
        },
      });

      const planEvent = await emitEvent({
        type: 'tool.planned',
        turn: i + 1,
        toolName: fn.name,
        parentEventId: callEvent?.id,
        payload: {
          callId: tc.id,
          capability: summarizeCapability(capability),
          policy,
          argsLength: fn.arguments.length,
          source: toolSource,
        },
      });

      const decision = applyPhaseGate(
        tools.evaluateTool(fn.name), fn.name, config.runContractMetadata,
      ) as ReturnType<typeof tools.evaluateTool>;
      // Tool call state: approved or denied
      await config.onToolCallState?.({
        callId: tc.id, toolName: fn.name,
        state: decision.allowed ? 'approved' : 'denied',
        turn: i + 1,
        error: decision.allowed ? undefined : decision.reason,
      });

      const decisionEvent = await emitEvent({
        type: decision.allowed ? 'tool.approved' : 'tool.denied',
        turn: i + 1,
        toolName: fn.name,
        parentEventId: planEvent?.id ?? callEvent?.id,
        payload: {
          callId: tc.id,
          allowed: decision.allowed,
          reasonCode: decision.allowed ? undefined : decision.reasonCode,
          reason: decision.allowed ? undefined : decision.reason,
          capability: summarizeCapability(decision.capability),
          policy: decision.policy,
        },
      });

      if (decision.allowed) {
        await config.onToolCallState?.({
          callId: tc.id, toolName: fn.name, state: 'running', turn: i + 1,
        });
      }

      const toolStartedAt = Date.now();
      const result = decision.allowed
        ? await withAbort(
            tools.execute({
              name: fn.name,
              arguments: args,
            }),
            signal,
          )
        : { content: '', error: decision.reason };
      const toolDurationMs = Date.now() - toolStartedAt;

      await config.onToolCallState?.({
        callId: tc.id, toolName: fn.name,
        state: result.error ? 'failed' : 'succeeded',
        turn: i + 1,
        outputSummary: result.error ? undefined : previewText(result.content, 200),
        error: result.error,
        durationMs: toolDurationMs,
        attempt: result.attempts ?? 1,
      });

      if (result.error) {
        sessionErrors.push({
          turn: i + 1,
          type: decision.allowed ? 'tool_execution_error' : 'tool_denied',
          toolName: fn.name,
          message: result.error,
        });
      }

      const content = result.error ?? result.content;
      toolResults.push(content);
      await emitEvent({
        type: 'tool.result',
        turn: i + 1,
        toolName: fn.name,
        parentEventId: decisionEvent?.id ?? callEvent?.id,
        payload: {
          callId: tc.id,
          ok: !result.error,
          denied: !decision.allowed,
          reasonCode: decision.allowed ? undefined : decision.reasonCode,
          durationMs: toolDurationMs,
          attempts: result.attempts ?? 1,
          retried: result.retried ?? false,
          retryErrors: result.retryErrors ?? [],
          contentPreview: previewText(content),
          contentLength: content.length,
          errorPreview: result.error ? previewText(result.error) : undefined,
          source: toolSource,
        },
      });

      messages.push({
        role: 'tool',
        content: content.slice(0, 8000), // Truncate very long results
        tool_call_id: tc.id,
      });
    }

    const turn: TurnSummary = {
      loopCount: i + 1,
      text: res.text,
      toolCalls: res.toolCalls,
      toolResults,
    };
    turns.push(turn);
    await config.onTurn?.(turn);
    await config.onCheckpoint?.({ messages: [...messages], turns: [...turns] });

    // Mid-loop context compression
    if (config.maxContextTokens && config.maxContextTokens > 0 &&
        config.contextCompression?.enabled !== false) {
      const compressed = compressOrTrimMessages(
        messages, config.maxContextTokens, config.contextCompression,
      );
      // Only replace if compression actually reduced the message count
      if (compressed.length < messages.length) {
        const previousLength = messages.length;
        messages.length = 0;
        messages.push(...compressed);
        log.debug(`Compressed context: ${compressed.length} messages (was ${previousLength})`);
      }
    }
  }

  // Max loops reached — ask model for final summary
  messages.push({
    role: 'user',
    content: 'You have reached the maximum number of turns. Please provide a final summary of what you accomplished and what remains to be done.',
  });

  assertNotAborted(signal);
  const finalRes = await withAbort(provider.chat(messages, undefined, {
    signal,
    traceId: config.traceId,
    sessionId: config.sessionId,
    modelSettings: config.modelSettings,
    onDelta: config.onModelDelta
      ? async (delta) => {
          await config.onModelDelta?.({ ...delta, turn: maxLoops + 1, provider: provider.name });
        }
      : undefined,
  }), signal);
  totalPromptTokens += finalRes.usage.promptTokens;
  totalCompletionTokens += finalRes.usage.completionTokens;

  log.warn(`Agent hit maxLoops (${maxLoops})`);
  // Add max-loops as an error
  sessionErrors.push({
    turn: maxLoops,
    type: 'max_loops_reached',
    message: `Agent reached the maximum of ${maxLoops} turns without completing.`,
  });
  await emitEvent({
    type: 'session.completed',
    turn: maxLoops + 1,
    payload: {
      loopCount: maxLoops + 1,
      totalTokens: totalPromptTokens + totalCompletionTokens,
      totalPromptTokens,
      totalCompletionTokens,
      totalCacheHitTokens,
      totalCacheMissTokens,
      totalCostUsd: totalCostUsd > 0 ? totalCostUsd : undefined,
      cacheEventCount,
      forcedSummary: true,
      errorSummary: summarizeSessionErrors(sessionErrors),
    },
  });

  return {
    text: finalRes.text,
    turns,
    loopCount: maxLoops + 1,
    totalTokens: { prompt: totalPromptTokens, completion: totalCompletionTokens },
    messages,
  };
  } finally {
    await mcpCleanup();
  }
}
