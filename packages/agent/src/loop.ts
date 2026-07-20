/**
 * @los/agent/loop — ReAct agent execution loop.
 *
 * Inspired by pi's agent-core and Codex's exec mode.
 * Flow: user prompt → setup → LLM call → tool execution → loop → text response.
 *
 * Setup phase (provider, tools, MCP, events, messages) lives in loop/setup.ts.
 */

import { estimateCost, summarizeModelProfile } from './model-profiles.js';
import { runPreExecutionPhases } from './loop/phases.js';
import {
  compressOrTrimMessages,
} from './loop/compression.js';
import {
  inferCacheHit,
  normalizeUsage,
  summarizeToolCalls,
  previewText,
  assertNotAborted,
  summarizeSessionErrors,
} from './loop/utils.js';
import { runToolCalls } from './loop/tool-runner.js';
import { withAbort } from './loop/utils.js';
import { setupAgentRun, completeAgentSetup } from './loop/setup.js';
import { runArchitectPhase } from './loop/architect-phase.js';
import { createProvider } from './providers/index.js';
import { healBeforeSend, repairToolCalls, StormBreaker, type RepairContext } from './providers/repair-pipeline.js';
import {
  createContextMonitor,
  type ContextFillState,
  formatContextFill,
} from './context-monitor.js';
import {
  evictMessages,
  type PersistedToolResultEvidence,
  type SemanticEvictionConfig,
} from './semantic-eviction.js';
import {
  createToolPreflightDiagnostic,
  resolveModelDiagnosticSnapshot,
} from './model-diagnostics.js';
import type {
  AgentConfig,
  AgentModelDelta,
  AgentResult,
  CheckpointState,
  ContextCompressionConfig,
  ToolCallStateTransition,
  TurnSummary,
} from './loop/types.js';
import type { Message, ToolCall } from './providers/index.js';
import {
  consumeOperatorControlEvents,
  type OperatorControlCursors,
} from './operator-control-consumer.js';

export type {
  AgentConfig,
  AgentModelDelta,
  AgentResult,
  CheckpointState,
  ContextCompressionConfig,
  ToolCallStateTransition,
  TurnSummary,
} from './loop/types.js';
export type {
  ModelDiagnosticConfig,
  ModelDiagnosticConcept,
  ModelDiagnosticInput,
  ModelDiagnosticKind,
  ModelDiagnosticMode,
  ModelDiagnosticPhase,
  ModelDiagnosticProbe,
  ModelDiagnosticRecommendation,
  ModelDiagnosticRiskLevel,
  ModelDiagnosticSnapshot,
  ToolPreflightDiagnostic,
} from './model-diagnostics.js';

// ── Core Loop ───────────────────────────────────────────

export async function runAgent(
  prompt: string,
  config: AgentConfig = {},
): Promise<AgentResult> {
  const setup = setupAgentRun(prompt, config, runAgent);
  const s = await completeAgentSetup(prompt, config, setup);

  const {
    log: agentLog, provider, modelProfile, toolMode, allowedTools,
    policy, signal, tools, mcpCleanup,
    toolDefs, toolNames, emitEvent, messages, maxLoops, preActionGateConfig,
    counters,
  } = s;

  let {
    totalPromptTokens,
    totalCompletionTokens,
    totalCacheHitTokens,
    totalCacheMissTokens,
    totalCostUsd,
    cacheEventCount,
  } = counters;

  const turns: TurnSummary[] = [];
  let operatorControlCursors: OperatorControlCursors = { steering: 0, followup: 0 };
  const sessionErrors: Array<{ turn: number; type: string; toolName?: string; message: string }> = [];
  const onSessionError = (err: typeof sessionErrors[number]) => { sessionErrors.push(err); };

  // Pre-execution discovery and planning turns moved to loop-phases.ts.
  // Enforcement (B0) is in the scheduler, not here.
  const phaseResult = config.skipPreExecutionPhases ? null : await runPreExecutionPhases(
    config.runContractMetadata ?? {}, {
      provider,
      emitEvent,
      messages,
      toolDefs,
      signal,
      toolMode,
      modelSettings: config.modelSettings,
      modelDiagnostics: config.modelDiagnostics,
    },
  );
  if (phaseResult) return phaseResult;

  // ── Architect/Editor dual-model: architect front-matter ──
  // When enabled, a reasoning-first architect produces a no-tools plan BEFORE
  // the editor (this main loop) executes it. The main loop already runs as the
  // editor (provider + editor system prompt resolved in setup). The plan is
  // injected as a user message so the editor operates on the architect's output.
  // See loop/architect-phase.ts and ADR 0007.
  if (config.architectEditor?.enabled) {
    const architectProviderName = config.architectEditor.architectProvider ?? config.provider;
    const architectProvider = createProvider(architectProviderName, {
      model: config.architectEditor.architectModel,
      traceId: config.traceId,
    });
    const archResult = await runArchitectPhase({
      provider: architectProvider,
      prompt,
      maxArchitectTurns: config.architectEditor.maxArchitectTurns,
      modelSettings: config.modelSettings,
      signal,
      traceId: config.traceId,
      sessionId: config.sessionId,
      onDelta: config.onModelDelta
        ? async (delta) => {
            await config.onModelDelta?.({ ...delta, turn: 0, provider: architectProvider.name });
          }
        : undefined,
      emitEvent,
    });
    if (archResult.truncated) {
      agentLog.warn(
        `Architect phase hit maxTurns (${archResult.turns}) without plan-end marker — proceeding with partial plan.`,
      );
    }
    messages.push({
      role: 'user',
      content: `The architect has produced the following plan. Execute it now using the available edit tools.\n\n--- Architect Plan ---\n${archResult.plan}\n--- End Plan ---`,
    });
    await emitEvent({
      type: 'architect.plan.injected',
      payload: {
        planLength: archResult.plan.length,
        architectTurns: archResult.turns,
        truncated: archResult.truncated,
      },
    });
  }

  // ── Context fill monitoring ──
  const persistedToolResults = new Map<string, PersistedToolResultEvidence>();
  const applyCriticalEviction = (fillPercent: number) => {
    if (config.contextCompression?.semanticEviction?.enabled === false) return;
    const evictedMessages = evictMessages(messages, persistedToolResults, {
      minResultBytes: config.contextCompression?.semanticEviction?.minResultBytes ?? 4096,
      maxStubChars: config.contextCompression?.semanticEviction?.maxStubChars ?? 200,
    });
    if (evictedMessages === messages) return;
    messages.length = 0;
    messages.push(...evictedMessages);
    agentLog.info(`Semantic eviction applied at critical fill (${(fillPercent * 100).toFixed(1)}%)`);
  };
  const ctxMon = config.contextMonitor
    ? createContextMonitor({
        contextWindowTokens: config.contextMonitor.contextWindowTokens ?? 200_000,
        warnThreshold: config.contextMonitor.warnThreshold ?? 0.60,
        checkpointThreshold: config.contextMonitor.checkpointThreshold ?? 0.75,
        criticalThreshold: config.contextMonitor.criticalThreshold ?? 0.85,
        onWarn: (s) => {
          agentLog.warn(formatContextFill(s));
          config.contextMonitor?.onWarn?.({
            fillPercent: s.fillPercent, usedTokens: s.usedTokens, turn: s.turn,
          });
          emitEvent({
            type: 'context.fill.warn',
            turn: s.turn,
            payload: { fillPercent: s.fillPercent, usedTokens: s.usedTokens, contextWindowTokens: s.contextWindowTokens },
          });
        },
        onCheckpoint: (s) => {
          agentLog.info(formatContextFill(s));
          config.contextMonitor?.onCheckpoint?.({
            fillPercent: s.fillPercent, usedTokens: s.usedTokens, turn: s.turn,
          });
          emitEvent({
            type: 'context.fill.checkpoint',
            turn: s.turn,
            payload: { fillPercent: s.fillPercent, usedTokens: s.usedTokens, contextWindowTokens: s.contextWindowTokens },
          });
        },
        onCritical: (s) => {
          agentLog.warn(formatContextFill(s));
          config.contextMonitor?.onCritical?.({
            fillPercent: s.fillPercent, usedTokens: s.usedTokens, turn: s.turn,
          });
          emitEvent({
            type: 'context.fill.critical',
            turn: s.turn,
            payload: { fillPercent: s.fillPercent, usedTokens: s.usedTokens, contextWindowTokens: s.contextWindowTokens },
          });
          applyCriticalEviction(s.fillPercent);
        },
      })
    : null;

  try {
    // ADR 0024: repair pipeline context. The storm breaker persists across
    // loop iterations (one user turn = one runAgent call) so repeated tool
    // calls across iterations are detected. isMutating maps to the tool's
    // `sideEffect` capability flag.
    const repairCtx: RepairContext = {
      providerName: provider.name,
      profile: provider.profile,
      traceId: config.traceId,
      stormBreaker: new StormBreaker({
        isMutating: (name) => tools.getCapability(name)?.sideEffect === true,
      }),
    };

    for (let i = 0; i < maxLoops; i++) {
    repairCtx.providerName = provider.name;
    repairCtx.profile = provider.profile;
    assertNotAborted(signal);
    const steering = await consumeOperatorControlEvents({
      sessionId: config.sessionId,
      runSpecId: config.runSpecId,
      taskRunId: config.taskRunId,
      turn: i + 1,
      boundary: 'before_turn',
      cursors: operatorControlCursors,
      includeFollowups: false,
    });
    operatorControlCursors = steering.cursors;
    messages.push(...steering.consumed.map(item => item.message));
    agentLog.debug(`Turn ${i + 1}/${maxLoops}`);
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

    // ADR 0024: pre-send healing — fix unpaired tool_calls / orphan tool
    // messages (e.g. from a resumed interrupted session) before the provider
    // rejects them with 400.
    healBeforeSend(messages, repairCtx);

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
    repairCtx.providerName = provider.name;
    repairCtx.profile = provider.profile;

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

    // ── Context fill monitoring after each turn ──
    let contextFill: { fillPercent: number; level: string; usedTokens: number } | undefined;
    if (ctxMon) {
      const fillState = ctxMon.update(res.usage, i + 1, messages.length);
      contextFill = { fillPercent: fillState.fillPercent, level: fillState.level, usedTokens: fillState.usedTokens };
    }
    const modelDiagnostic = await resolveModelDiagnosticSnapshot({
      messages,
      response: res,
      phase: 'execution',
      turn: i + 1,
      provider: provider.name,
      model: res.model,
      toolCalls: res.toolCalls,
    }, config.modelDiagnostics);

    await emitEvent({
      type: 'model.response',
      turn: i + 1,
      model: res.model,
      cacheHit: inferCacheHit(res.usage),
      usage: normalizeUsage(res.usage),
      payload: {
        provider: provider.name,
        modelProfile: summarizeModelProfile(provider.profile),
        durationMs: modelDurationMs,
        textPreview: previewText(res.text),
        textLength: res.text.length,
        reasoningPreview: res.reasoningContent ? previewText(res.reasoningContent) : undefined,
        reasoningLength: res.reasoningContent?.length ?? 0,
        toolCallCount: res.toolCalls.length,
        toolCalls: summarizeToolCalls(res.toolCalls),
        cost: turnCost ?? undefined,
        transport: provider.profile.transportHints?.[0] ?? 'http-stream',
        diagnostics: modelDiagnostic ? { model: modelDiagnostic } : undefined,
        ...(contextFill ? { contextFill } : {}),
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

    // ADR 0024: post-response repair (storm breaking). Suppressed calls are
    // dropped from both the assistant message and dispatch so tool_call ↔
    // tool_result pairing stays intact.
    const repaired = repairToolCalls(res.toolCalls, repairCtx);
    const toolPreflight = createToolPreflightDiagnostic(modelDiagnostic, repaired.calls);
    if (toolPreflight &&
        (toolPreflight.riskLevel !== 'low' || config.modelDiagnostics?.emitLowRiskToolPreflight === true)) {
      await emitEvent({
        type: 'tool.preflight_diagnostic',
        turn: i + 1,
        model: res.model,
        payload: { ...toolPreflight },
      });
    }

    // Add assistant message
    const assistantMsg: Message = {
      role: 'assistant',
      content: res.text,
      tool_calls: repaired.calls.length > 0 ? repaired.calls : undefined,
    };
    messages.push(assistantMsg);

    // If no tool calls, we're done — but first verify it's a genuine finish,
    // not a truncated response or idle ack from a reasoning-heavy model.
    if (res.toolCalls.length === 0) {
      // finish_reason='length' means the model was cut off mid-response.
      // Don't accept this as completion — record the error and continue.
      if (res.finishReason === 'length') {
        agentLog.warn(`Turn ${i + 1}: model response truncated (finish_reason=length). ` +
          `Text length: ${res.text.length}, reasoning: ${(res.reasoningContent ?? '').length}. Continuing loop.`);
        onSessionError({
          turn: i + 1,
          type: 'truncated_response',
          message: `Model response truncated by token limit (finish_reason=length). Text length: ${res.text.length}. The model may need another turn to complete.`,
        });
        await emitEvent({
          type: 'model.response.truncated',
          turn: i + 1,
          model: res.model,
          payload: {
            finishReason: res.finishReason,
            textLength: res.text.length,
            reasoningLength: (res.reasoningContent ?? '').length,
          },
        });
        // Don't exit — let the loop continue for the model to finish
        continue;
      }

      if (i + 1 < maxLoops) {
        const queuedControl = await consumeOperatorControlEvents({
          sessionId: config.sessionId,
          runSpecId: config.runSpecId,
          taskRunId: config.taskRunId,
          turn: i + 1,
          boundary: 'after_completion',
          cursors: operatorControlCursors,
          includeFollowups: true,
        });
        operatorControlCursors = queuedControl.cursors;
        if (queuedControl.consumed.length > 0) {
          messages.push(...queuedControl.consumed.map(item => item.message));
          continue;
        }
      }

      // If reasoning-only (R1-style) with empty/minimal text, warn but still complete.
      // The model may have genuinely decided no action is needed.
      if (!res.text || res.text.trim().length === 0) {
        agentLog.warn(`Turn ${i + 1}: empty text response (reasoning only). ` +
          `Reasoning length: ${(res.reasoningContent ?? '').length}. Completing.`);
      }
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

      agentLog.info(`Agent finished — ${i + 1} turns, ${totalPromptTokens + totalCompletionTokens} tokens`);
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
    const { toolResults, toolMessages, persistedToolResults: turnPersistedResults } = await runToolCalls({
      toolCalls: repaired.calls,
      turn: i + 1,
      tools,
      config,
      signal,
      policy,
      emitEvent,
      onSessionError,
      preActionGateConfig,
    });
    for (const [callId, evidence] of turnPersistedResults) {
      persistedToolResults.set(callId, evidence);
    }
    messages.push(...toolMessages);
    const currentFill = ctxMon?.getState();
    if (currentFill?.level === 'critical') {
      applyCriticalEviction(currentFill.fillPercent);
    }

    const turn: TurnSummary = {
      loopCount: i + 1,
      text: res.text,
      toolCalls: repaired.calls,
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
        agentLog.debug(`Compressed context: ${compressed.length} messages (was ${previousLength})`);
      }
    }
  }

  // Max loops reached — ask model for final summary
  messages.push({
    role: 'user',
    content: 'You have reached the maximum number of turns. Please provide a final summary of what you accomplished and what remains to be done.',
  });

  assertNotAborted(signal);
  healBeforeSend(messages, repairCtx);
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

  agentLog.warn(`Agent hit maxLoops (${maxLoops})`);
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
