/**
 * @los/agent/loop — ReAct agent execution loop.
 *
 * Inspired by pi's agent-core and Codex's exec mode.
 * Flow: user prompt → setup → LLM call → tool execution → loop → text response.
 *
 * Setup phase (provider, tools, MCP, events, messages) lives in loop/setup.ts.
 */

import { estimateCost } from './model-profiles.js';
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
import {
  createContextMonitor,
  type ContextFillState,
  formatContextFill,
} from './context-monitor.js';
import {
  evictMessages,
  type SemanticEvictionConfig,
} from './semantic-eviction.js';
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
  const setup = setupAgentRun(prompt, config, runAgent);
  const s = await completeAgentSetup(prompt, config, setup);

  const {
    log: agentLog, provider, modelProfile, toolMode, allowedTools,
    policy, signal, tools, mcpCleanup,
    toolDefs, toolNames, emitEvent, messages, maxLoops,
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
  const sessionErrors: Array<{ turn: number; type: string; toolName?: string; message: string }> = [];
  const onSessionError = (err: typeof sessionErrors[number]) => { sessionErrors.push(err); };

  // Pre-execution discovery and planning turns moved to loop-phases.ts.
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

  // ── Context fill monitoring ──
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
          // Apply semantic eviction at critical fill to free context window
          if (config.contextCompression?.semanticEviction?.enabled !== false) {
            const persistedLocs = new Map<string, any[]>();
            // Derive persisted locations from observation IDs in message metadata
            for (let j = 0; j < messages.length; j++) {
              const m = messages[j] as any;
              if (m.role === 'tool' && m.tool_call_id && m.observation_id) {
                persistedLocs.set(m.tool_call_id, [{
                  kind: 'observation' as const,
                  id: String(m.observation_id),
                  label: `observation #${m.observation_id}`,
                }]);
              }
            }
            const evictedMsgs = evictMessages(messages as any[], persistedLocs, {
              minResultBytes: config.contextCompression?.semanticEviction?.minResultBytes ?? 4096,
              maxStubChars: config.contextCompression?.semanticEviction?.maxStubChars ?? 200,
            });
            if (evictedMsgs !== messages) {
              messages.length = 0;
              messages.push(...evictedMsgs as typeof messages);
              agentLog.info(`Semantic eviction applied at critical fill (${(s.fillPercent * 100).toFixed(1)}%)`);
            }
          }
        },
      })
    : null;

  try {
    for (let i = 0; i < maxLoops; i++) {
    assertNotAborted(signal);
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

    // ── Context fill monitoring after each turn ──
    let contextFill: { fillPercent: number; level: string; usedTokens: number } | undefined;
    if (ctxMon) {
      const fillState = ctxMon.update(res.usage, i + 1, messages.length);
      contextFill = { fillPercent: fillState.fillPercent, level: fillState.level, usedTokens: fillState.usedTokens };
    }

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

    // Add assistant message
    const assistantMsg: Message = {
      role: 'assistant',
      content: res.text,
      tool_calls: res.toolCalls.length > 0 ? res.toolCalls : undefined,
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
    const { toolResults, toolMessages } = await runToolCalls({
      toolCalls: res.toolCalls,
      turn: i + 1,
      tools,
      config,
      signal,
      policy,
      emitEvent,
      onSessionError,
    });
    messages.push(...toolMessages);

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
