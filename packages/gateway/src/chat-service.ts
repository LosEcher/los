import { runScheduledAgentTask } from '@los/agent/scheduler';
import type { Config } from '@los/infra/config';
import type { Logger } from '@los/infra/logger';
import {
  ensureSessionStore,
  loadSession,
  saveSession,
} from '@los/agent/session';
import type { Message, CheckpointState, RunContractMetadataInput } from '@los/agent';
import {
  loadResumeState,
  updateBoundTodoFromRun,
  loadBranchSource,
} from './chat-session-helpers.js';
import {
  ensureRunSpecStore,
  createRunSpec,
} from '@los/agent/run-specs';
import { augmentChatSystemPrompt } from './chat-memory-augment.js';
import { persistStreamCheckpoint } from './chat-stream-persist.js';
import {
  emitRunningToolCallUpsert,
  emitToolCallUpsertFromSessionEvent,
  relaySessionEvent,
  type SendEvent,
} from './chat-live-events.js';
import { persistChatSuccess } from './chat-route-persist.js';
import type { MCPRequestServer } from './chat-normalizers.js';

export type { SendEvent } from './chat-live-events.js';

export interface ChatRunContext {
  activeTaskRunId: string | undefined;
  activeRunSpecId: string | undefined;
  lastCheckpoint: CheckpointState | null;
}

export type ChatStatus = 'completed' | 'deduplicated' | 'cancelled';

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
  sid: string;
  tenantId: string;
  projectId: string;
  userId: string;
  requestId: string;
  runContract: RunContractMetadataInput | undefined;
  config: Config;
  gatewayServiceId: string | undefined;
  log: Logger;
  ctx: ChatRunContext;
  send: SendEvent;
}): Promise<ChatResult> {
  const {
    prompt, sessionId, systemPrompt, provider, model, modelSettings,
    workspaceRoot, toolMode, allowedTools, maxLoops, timeoutMs, toolRetry,
    mcpServers, persistMemory, boundTodoId, branchFrom, branchAtTurn,
    traceId, dedupeKey, sid, tenantId, projectId, userId, requestId,
    runContract, config, gatewayServiceId, log, ctx, send,
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

  const effectiveSystemPrompt = await augmentChatSystemPrompt({
    systemPrompt,
    toolMode,
    sessionId: sid,
    runSpecId,
    tenantId,
    projectId,
  });

  try {
    const resumeState = resumedSession ? await loadResumeState(sid) : null;
    if (resumedSession) {
      const turnPreviews = resumedSession.turns.map(t => ({
        loop: t.loopCount,
        text: t.text.slice(0, 100),
        tools: t.toolCalls.map((tc: any) => tc.function.name),
        hasReasoning: Boolean(t.reasoningContent),
      }));
      send('session.resumed', {
        sessionId: sid,
        messageCount: resumedSession.messages.length,
        turnCount: resumedSession.turns.length,
        turnPreviews,
        lastTaskRun: resumeState?.lastTaskRun ?? null,
        activeTaskRuns: resumeState?.activeTaskRuns ?? [],
        lastEventId: resumeState?.lastEventId ?? null,
        recentEventCount: resumeState?.recentEventCount ?? 0,
      });
      send('session.resume_state', {
        sessionId: sid,
        tasks: resumeState?.recentTaskRuns ?? [],
        recentEvents: resumeState?.recentEvents ?? [],
      });
    }

    if (branchFrom && branchParentForEvent) {
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
      initialMessages: branchSourceMessages ?? resumedSession?.messages,
      allowedTools,
      maxLoops,
      traceId,
      dedupeKey,
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
