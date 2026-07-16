import { runScheduledAgentTask } from '@los/agent/scheduler';
import type { Config } from '@los/infra/config';
import type { Logger } from '@los/infra/logger';
import { ensureSessionStore, loadSession, saveSession } from '@los/agent/session';
import type { Message, CheckpointState, RunContractMetadataInput, IdentityLevel } from '@los/agent';
import { updateBoundTodoFromRun, loadBranchSource } from './chat-session-helpers.js';
import { ensureRunSpecStore, createRunSpec } from '@los/agent/run-specs';
import { recordSessionBranchCreated } from '@los/agent/operator-control';
import { prepareChatContextPolicy } from './chat-context-policy.js';
import { persistStreamCheckpoint } from './chat-stream-persist.js';
import {
  emitRunningToolCallUpsert,
  emitToolCallUpsertFromSessionEvent,
  relaySessionEvent,
  type SendEvent,
} from './chat-live-events.js';
import { persistChatSuccess } from './chat-route-persist.js';
import type { MCPRequestServer } from './chat-normalizers.js';
import { persistChatIntakeEvent } from './chat-intake-events.js';
import {
  applyChatResumeDispatchGuard,
  prepareChatResumePlan,
  sendChatResumeState,
} from './chat-resume-plan.js';

export type { SendEvent } from './chat-live-events.js';

export interface ChatRunContext {
  activeTaskRunId: string | undefined;
  activeRunSpecId: string | undefined;
  lastCheckpoint: CheckpointState | null;
}

export type ChatStatus = 'completed' | 'deduplicated' | 'cancelled' | 'blocked';

/** Per-session checkpoint counters for mid-session auto-compaction (P0-1). */
const checkpointTracker = new Map<string, { count: number; lastAt: number }>();

export interface ChatResult {
  status: ChatStatus;
  sessionId: string;
  taskRunId: string;
  traceId: string;
  result?: {
    text: string;
    loopCount: number;
    totalTokens: number;
    runCompletionStatus: string | null;
    blockedVerificationRecordIds: string[];
  };
  cancelReason?: string;
}

export async function runChat(params: {
  prompt: string;
  sessionId: string | undefined;
  systemPrompt: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  modelSettings: Record<string, unknown> | undefined;
  workspaceRoot: string;
  toolMode: string;
  sandboxMode?: string;
  allowedTools: string[] | undefined;
  maxLoops: number | undefined;
  timeoutMs: number | undefined;
  toolRetry: Record<string, unknown> | undefined;
  mcpServers: MCPRequestServer[] | undefined;
  persistMemory: boolean;
  boundTodoId: string | undefined;
  branchFrom: string | undefined;
  branchAtTurn: number | undefined;
  traceId: string;
  dedupeKey: string | undefined;
  signal?: AbortSignal;
  sid: string;
  tenantId: string;
  projectId: string;
  userId: string;
  actorSubject: string;
  requestId: string;
  runContract: RunContractMetadataInput | undefined;
  intakeResolution: import('@los/agent/task-intake').ProjectOwnerResolution;
  requestedProjectId: string | undefined;
  requestedWorkspaceRoot: string | undefined;
  config: Config;
  gatewayServiceId: string | undefined;
  identityName: string | undefined;
  identityLevel: string | undefined;
  log: Logger;
  ctx: ChatRunContext;
  send: SendEvent;
}): Promise<ChatResult> {
  const {
    prompt, sessionId, systemPrompt, provider, model, modelSettings,
    workspaceRoot, toolMode, allowedTools, maxLoops, timeoutMs, toolRetry,
    mcpServers, persistMemory, boundTodoId, branchFrom, branchAtTurn,
    traceId, dedupeKey, signal, sid, tenantId, projectId, userId, actorSubject, requestId,
    runContract, intakeResolution, requestedProjectId, requestedWorkspaceRoot,
    config, gatewayServiceId, identityName, identityLevel, log, ctx, send,
  } = params;

  // ── Branch source loading ──
  let branchSourceMessages: Message[] | null = null;
  let branchParentForEvent: Awaited<ReturnType<typeof loadSession>> | null = null;
  if (branchFrom) {
    const result = await loadBranchSource(branchFrom, branchAtTurn);
    if ('error' in result) {
      send('error', { message: result.error });
      return { status: 'cancelled', sessionId: sid, taskRunId: '', traceId, cancelReason: result.error };
    }
    branchSourceMessages = result.messages;
    branchParentForEvent = result.parent;
  }

  // ── Resume session loading ──
  const resumedSession = (!branchFrom && sessionId) ? await loadSession(sid) : null;

  // ── Run spec creation ──
  await ensureRunSpecStore();
  const runSpecId = `run-${sid}-${Date.now()}`;
  ctx.activeRunSpecId = runSpecId;
  await createRunSpec({
    id: runSpecId,
    sessionId: sid,
    tenantId,
    projectId,
    userId,
    requestId,
    traceId,
    prompt,
    systemPrompt,
    provider: provider ?? null as any,
    model: model ?? null as any,
    modelSettings: (modelSettings ?? {}) as Record<string, unknown>,
    workspaceRoot,
    toolMode,
    allowedTools: allowedTools ?? [],
    toolRetry: (toolRetry ?? {}) as Record<string, unknown>,
    maxLoops: maxLoops ?? config.agent.maxLoops,
    timeoutMs,
    mcpServers,
    runContract,
    gatewayId: gatewayServiceId,
  });
  relaySessionEvent(send, await persistChatIntakeEvent({
    sessionId: sid, tenantId, userId, requestId, traceId,
    requestedProjectId, requestedWorkspaceRoot, resolution: intakeResolution, runSpecId,
  }));

  if (boundTodoId) {
    await updateBoundTodoFromRun(boundTodoId, {
      status: 'in_progress',
      sessionId: sid,
      traceId,
      requestId,
      runSpecId,
      event: 'run_spec.created',
    }).catch(() => undefined);
  }

  const preparedContext = await prepareChatContextPolicy({
    sessionId: sid, runSpecId, tenantId, projectId, userId, requestId, traceId,
    workspaceRoot, toolMode, systemPrompt, identityName,
    identityLevel: identityLevel as IdentityLevel | undefined,
  });
  const effectiveSystemPrompt = preparedContext.systemPrompt;
  relaySessionEvent(send, preparedContext.event);

  // ── CBM shadow mode: measure code graph queries without injecting ──
  if ((config.memory as any)?.codeGraph?.shadowMode && (config.memory as any)?.codeGraph?.enabled) {
    import('./chat-cbm-shadow.js').then(m => m.measureCBMShadow(sid, runSpecId, prompt, workspaceRoot)).catch(() => undefined);
  }

  try {
    const preparedResume = resumedSession ? await prepareChatResumePlan({
      sessionId: sid, currentRunSpecId: runSpecId, tenantId, projectId,
      userId, requestId, traceId,
    }) : null;
    const resumeState = preparedResume?.resumeState ?? null;
    if (resumedSession && preparedResume) {
      relaySessionEvent(send, preparedResume.event);
      sendChatResumeState(send, resumedSession, preparedResume);
      const guard = await applyChatResumeDispatchGuard({
        plan: preparedResume.plan, planEventId: preparedResume.event.id,
        currentRunSpecId: runSpecId, requestId, traceId,
      });
      if (guard.event) relaySessionEvent(send, guard.event);
      if (guard.disposition === 'suppress') {
        if (boundTodoId) {
          await updateBoundTodoFromRun(boundTodoId, {
            status: 'blocked', sessionId: sid, traceId, requestId, runSpecId,
            event: 'run.resume_dispatch_suppressed', reason: guard.reason,
          }).catch(() => undefined);
        }
        send('session.blocked', {
          sessionId: sid, runSpecId, reason: guard.reason,
          selectedRunSpecId: preparedResume.plan.selectedRunSpecId,
          activeTaskRunIds: preparedResume.plan.sessionActiveTaskRunIds,
        });
        return { status: 'blocked', sessionId: sid, taskRunId: '', traceId };
      }
    }

    if (branchFrom && branchParentForEvent) {
      await recordSessionBranchCreated({
        sessionId: sid,
        parentSessionId: branchFrom,
        branchAtTurn,
        copiedMessageCount: branchSourceMessages?.length ?? branchParentForEvent.messages.length,
        parentMessageCount: branchParentForEvent.messages.length,
        parentTurnCount: branchParentForEvent.turns.length,
        runSpecId,
        tenantId,
        projectId,
        userId,
        requestId,
        traceId,
        actor: actorSubject,
        reason: 'chat_branch_created',
      });
      send('session.branched', {
        sessionId: sid,
        parentSessionId: branchFrom,
        branchAtTurn: branchAtTurn ?? null,
        messageCount: branchParentForEvent.messages.length,
        turnCount: branchParentForEvent.turns.length,
        copiedMessageCount: branchSourceMessages?.length ?? branchParentForEvent.messages.length,
      });
    }

    let sentSession = false;

    const scheduled = await runScheduledAgentTask({
      prompt,
      sessionId: sid,
      runSpecId,
      provider,
      model,
      modelSettings,
      systemPrompt: effectiveSystemPrompt,
      workspaceRoot,
      toolMode: toolMode as 'all' | 'project-write' | 'read-only',
      sandboxMode: params.sandboxMode
        ? (params.sandboxMode as 'readonly' | 'workspace-write' | 'sandbox')
        : (config as any).agent?.sandboxMode as 'readonly' | 'workspace-write' | 'sandbox' | undefined,
      initialMessages: branchSourceMessages ?? resumedSession?.messages,
      allowedTools,
      maxLoops,
      traceId,
      dedupeKey,
      signal,
      tenantId,
      projectId,
      userId,
      requestId,
      timeoutMs,
      toolRetry,
      mcpServers,
      runContract,
      log,
      executor: {
        enabled: config.executor.enabled,
        nodeUrls: config.executor.meshNodes,
        agentKey: config.executor.agentKey,
        nodeId: config.executor.nodeId,
      },
      metadata: {
        maxLoops: maxLoops ?? config.agent.maxLoops,
        model,
        modelSettings,
        allowedTools,
        timeoutMs,
        toolRetry,
        requestId,
        tenantId,
        projectId,
        userId,
      },
      onTaskEvent: (event) => {
        ctx.activeTaskRunId = event.taskRun.id;
        if (!sentSession && event.type !== 'task.deduplicated') {
          sentSession = true;
          send('session', {
            sessionId: event.taskRun.sessionId,
            taskRunId: event.taskRun.id,
            traceId: event.taskRun.traceId,
            requestId,
            nodeId: event.taskRun.nodeId ?? null,
            dedupeKey: event.taskRun.dedupeKey ?? null,
            model: event.taskRun.model ?? null,
          });
        }
        send('task', {
          type: event.type,
          taskRunId: event.taskRun.id,
          sessionId: event.taskRun.sessionId,
          traceId: event.taskRun.traceId,
          requestId,
          nodeId: event.taskRun.nodeId ?? null,
          dedupeKey: event.taskRun.dedupeKey ?? null,
          status: event.taskRun.status,
          model: event.taskRun.model ?? null,
        });
      },
      onTurn: async (turn) => {
        send('turn', {
          loopCount: turn.loopCount,
          text: turn.text.slice(0, 200),
          toolCallCount: turn.toolCalls.length,
          toolNames: turn.toolCalls.map((tc: any) => tc.function.name),
          reasoning: turn.reasoningContent?.slice(0, 200),
        });
        await persistStreamCheckpoint({
          sessionId: sid, runSpecId, eventType: 'turn', turn: turn.loopCount,
          payload: { loopCount: turn.loopCount, textPreview: turn.text.slice(0, 500), toolCallCount: turn.toolCalls.length, toolNames: turn.toolCalls.map((tc: any) => tc.function.name) },
        });
      },
      onToolCall: async (callId, tool, args, turn) => {
        await emitRunningToolCallUpsert({ send, sessionId: sid, runSpecId, turn, callId, toolName: tool, input: args });
        // Phase 3: resolve CBM symbols for write operations (best-effort, fire-and-forget)
        import('./chat-cbm-symbol-cache.js').then(m =>
          m.cacheSymbolsForToolCall(sid, callId, tool, args as Record<string, unknown>, workspaceRoot),
        ).catch(() => undefined);
      },
      onModelDelta: async (delta) => {
        send('model.delta', {
          turn: delta.turn,
          provider: delta.provider,
          model: delta.model ?? null,
          textDelta: delta.textDelta ?? '',
          reasoningDelta: delta.reasoningDelta ?? '',
        });
        await persistStreamCheckpoint({
          sessionId: sid, runSpecId, eventType: 'model.delta', turn: delta.turn,
          payload: { provider: delta.provider, model: delta.model ?? null, textDelta: delta.textDelta ?? '', reasoningDelta: delta.reasoningDelta ?? '' },
        });
      },
      onCheckpoint: async (state) => {
        ctx.lastCheckpoint = state;
        await ensureSessionStore().catch(() => undefined);
        await saveSession({
          id: sid, tenantId, projectId, userId, requestId, traceId,
          createdAt: resumedSession?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: state.messages,
          turns: resumedSession ? [...resumedSession.turns, ...state.turns] : state.turns,
          metadata: {
            ...(resumedSession?.metadata ?? {}),
            provider: provider ?? config.agent.defaultProvider,
            model: model ?? null,
            workspaceRoot,
            toolMode,
            branchFrom: branchFrom ?? null,
            branchAtTurn: branchAtTurn ?? null,
          },
        }).catch(() => undefined);
      },
      onSessionEvent: async (event) => {
        relaySessionEvent(send, event);
        await emitToolCallUpsertFromSessionEvent({ send, sessionId: sid, runSpecId, event });

        // Auto-trigger memory compaction when a session completes or errors
        if (event.type === 'session.completed' || event.type === 'session.error') {
          import('@los/memory').then(({ compactSession }) =>
            compactSession({ sessionId: sid, runSpecId }).catch(() => undefined)
          ).catch(() => undefined);
          checkpointTracker.delete(sid);
        } else {
          // Mid-session checkpoint tracking (P0-1: 3 triggers)
          const ck = checkpointTracker.get(sid) ?? { count: 0, lastAt: Date.now() };
          ck.count += 1;
          const isToolTransition = event.type === 'tool_call_state.updated'
            && ((event.payload as any)?.to === 'succeeded' || (event.payload as any)?.to === 'failed');
          const timeSinceLast = Date.now() - ck.lastAt;
          const triggeredByCount = ck.count >= 20;
          const shouldCheckpoint = triggeredByCount || isToolTransition
            || timeSinceLast >= 10 * 60 * 1000; // 10-min fallback
          if (shouldCheckpoint) {
            ck.count = 0;
            ck.lastAt = Date.now();
            const trigger = triggeredByCount ? 'event_count'
              : isToolTransition ? 'tool_state_change' : 'time_interval';
            import('@los/memory').then(({ compactSession }) =>
              compactSession({ sessionId: sid, runSpecId, checkpoint: true, autoTrigger: trigger }).catch(() => undefined)
            ).catch(() => undefined);
          }
          checkpointTracker.set(sid, ck);
        }
      },
    });

    // ── Deduplicated outcome ──
    if (scheduled.status === 'deduplicated') {
      send('deduplicated', {
        sessionId: scheduled.sessionId,
        taskRunId: scheduled.taskRun.id,
        traceId: scheduled.taskRun.traceId,
        requestId,
        dedupeKey: scheduled.taskRun.dedupeKey ?? null,
        status: scheduled.taskRun.status,
      });
      send('done', {
        deduplicated: true,
        sessionId: scheduled.sessionId,
        taskRunId: scheduled.taskRun.id,
      });
      await ensureSessionStore().catch(() => undefined);
      await saveSession({
        id: scheduled.sessionId, tenantId, projectId, userId, requestId, traceId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [], turns: [],
        metadata: {
          provider: provider ?? config.agent.defaultProvider,
          model: model ?? null, workspaceRoot, toolMode,
          deduplicated: true,
          dedupeKey: scheduled.taskRun.dedupeKey ?? null,
        },
      }).catch(() => undefined);
      return {
        status: 'deduplicated',
        sessionId: scheduled.sessionId,
        taskRunId: scheduled.taskRun.id,
        traceId: scheduled.taskRun.traceId,
      };
    }

    // ── Cancelled outcome ──
    if (scheduled.status === 'cancelled') {
      if (boundTodoId) {
        await updateBoundTodoFromRun(boundTodoId, {
          status: 'cancelled',
          sessionId: scheduled.sessionId,
          taskRunId: scheduled.taskRun.id,
          traceId: scheduled.taskRun.traceId,
          requestId,
          runSpecId,
          event: 'task.cancelled',
          reason: scheduled.reason,
        });
      }
      send('cancelled', {
        sessionId: scheduled.sessionId,
        taskRunId: scheduled.taskRun.id,
        traceId: scheduled.taskRun.traceId,
        requestId,
        dedupeKey: scheduled.taskRun.dedupeKey ?? null,
        reason: scheduled.reason,
      });
      send('done', {
        cancelled: true,
        sessionId: scheduled.sessionId,
        taskRunId: scheduled.taskRun.id,
        reason: scheduled.reason,
      });
      await ensureSessionStore().catch(() => undefined);
      await saveSession({
        id: scheduled.sessionId, tenantId, projectId, userId, requestId, traceId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [], turns: [],
        metadata: {
          provider: provider ?? config.agent.defaultProvider,
          model: model ?? null, workspaceRoot, toolMode,
          cancelled: true, cancelReason: scheduled.reason, prompt,
        },
      }).catch(() => undefined);
      return {
        status: 'cancelled',
        sessionId: scheduled.sessionId,
        taskRunId: scheduled.taskRun.id,
        traceId: scheduled.taskRun.traceId,
        cancelReason: scheduled.reason,
      };
    }

    // ── Blocked outcome (self-check failed) ──
    if (scheduled.status === 'blocked') {
      // Phase 2: Record self-reflection when the agent has learned about
      // its own failure patterns. Best-effort — gateway has both @los/agent
      // and @los/memory, no circular dep.
      try {
        const { recordSelfReflection } = await import('@los/memory');
        const reflectionMeta = (scheduled.taskRun.metadata as Record<string, unknown> | undefined)?.reflection as
          { summary?: string; recoveryType?: string; recoveryActions?: string[] } | undefined;
        if (reflectionMeta?.summary) {
          await recordSelfReflection({
            agentIdentity: identityName ?? 'default',
            insight: reflectionMeta.summary,
            confidence: 0.7,
            evidenceSessionIds: [sid],
            category: 'weakness',
            sessionId: sid,
            tenantId,
            projectId,
          });
        }
      } catch { /* Self-reflection recording is best-effort */ }

      send('blocked', {
        sessionId: scheduled.sessionId,
        taskRunId: scheduled.taskRun.id,
        traceId: scheduled.taskRun.traceId,
        requestId,
        reason: scheduled.reason,
      });
      return {
        status: 'blocked',
        sessionId: scheduled.sessionId,
        taskRunId: scheduled.taskRun.id,
        traceId: scheduled.taskRun.traceId,
        cancelReason: scheduled.reason,
      };
    }

    // ── Completed outcome ──
    const result = scheduled.result;
    const taskRunId = scheduled.taskRun.id;

    await ensureSessionStore();
    await saveSession({
      id: sid, tenantId, projectId, userId,
      nodeId: scheduled.taskRun.nodeId,
      requestId, traceId: scheduled.taskRun.traceId,
      createdAt: resumedSession?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: result.messages,
      turns: resumedSession ? [...resumedSession.turns, ...result.turns] : result.turns,
      metadata: {
        ...(resumedSession?.metadata ?? {}),
        provider: provider ?? config.agent.defaultProvider,
        model: scheduled.taskRun.model ?? model ?? null,
        modelSettings: modelSettings ?? null,
        workspaceRoot, toolMode, allowedTools,
        maxLoops: maxLoops ?? config.agent.maxLoops,
        timeoutMs, toolRetry, taskRunId,
        traceId: scheduled.taskRun.traceId,
        requestId, tenantId, projectId, userId,
        nodeId: scheduled.taskRun.nodeId ?? null,
        dedupeKey: scheduled.taskRun.dedupeKey ?? null,
        resumed: Boolean(resumedSession),
        resumeMessageCount: resumedSession?.messages.length ?? 0,
        resumeLastTaskRunId: resumeState?.lastTaskRun?.id ?? null,
        resumeLastTaskStatus: resumeState?.lastTaskRun?.status ?? null,
        resumeLastEventId: resumeState?.lastEventId ?? null,
      },
    });

    const { runCompletion, todoCompletionStatus } = await persistChatSuccess({
      prompt,
      result: { text: result.text, loopCount: result.loopCount, totalTokens: result.totalTokens.prompt + result.totalTokens.completion },
      persistMemory,
      sessionId: sid,
      boundTodoId: boundTodoId ?? null,
      runSpecId,
      taskRunId,
      traceId: scheduled.taskRun.traceId,
      requestId,
      tenantId,
      projectId,
      userId,
      nodeId: scheduled.taskRun.nodeId ?? null,
    });

    send('done', {
      text: result.text,
      turns: result.loopCount,
      tokens: result.totalTokens,
      sessionId: sid,
      runSpecId,
      runSpecStatus: runCompletion?.status ?? null,
      blockedVerificationRecordIds: runCompletion?.blockedVerificationRecordIds ?? [],
      taskRunId,
      traceId: scheduled.taskRun.traceId,
      requestId,
      nodeId: scheduled.taskRun.nodeId ?? null,
    });

    return {
      status: 'completed',
      sessionId: sid,
      taskRunId,
      traceId: scheduled.taskRun.traceId,
      result: {
        text: result.text,
        loopCount: result.loopCount,
        totalTokens: result.totalTokens.prompt + result.totalTokens.completion,
        runCompletionStatus: runCompletion?.status ?? null,
        blockedVerificationRecordIds: runCompletion?.blockedVerificationRecordIds ?? [],
      },
    };
  } catch (err: any) {
    // The route's catch block handles error persistence via persistChatError.
    // Re-throw so the route can access ctx for the mutable state.
    throw err;
  }
}
