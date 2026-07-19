import { runScheduledAgentTask } from '@los/agent/scheduler';
import type { Config } from '@los/infra/config';
import type { Logger } from '@los/infra/logger';
import { ensureSessionStore, loadSession, saveSession } from '@los/agent/session';
import type { Message, CheckpointState, RunContractMetadataInput, IdentityLevel, ProviderFallbackPolicy } from '@los/agent';
import { updateBoundTodoFromRun, loadBranchSource } from './chat-session-helpers.js';
import { ensureRunSpecStore, createRunSpec } from '@los/agent/run-specs';
import { recordSessionBranchCreated } from '@los/agent/operator-control';
import { prepareChatContextPolicy } from './chat-context-policy.js';
import { relaySessionEvent, type SendEvent } from './chat-live-events.js';
import { persistChatSuccess } from './chat-route-persist.js';
import type { MCPRequestServer } from './chat-normalizers.js';
import { persistChatIntakeEvent } from './chat-intake-events.js';
import {
  applyChatResumeDispatchGuard,
  prepareChatResumePlan,
  sendChatResumeState,
} from './chat-resume-plan.js';
import { handleNonCompletedOutcome } from './chat-service-outcomes.js';
import { createChatTaskHooks } from './chat-service-hooks.js';

export type { SendEvent } from './chat-live-events.js';
export interface ChatRunContext {
  activeTaskRunId: string | undefined;
  activeRunSpecId: string | undefined;
  lastCheckpoint: CheckpointState | null;
}

export type ChatStatus = 'completed' | 'deduplicated' | 'cancelled' | 'blocked';

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
  providerFallback: ProviderFallbackPolicy | undefined;
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
    prompt, sessionId, systemPrompt, provider, model, providerFallback, modelSettings,
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

    const scheduled = await runScheduledAgentTask({
      prompt,
      sessionId: sid,
      runSpecId,
      provider,
      model,
      providerFallback,
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
        providerFallback,
        modelSettings,
        allowedTools,
        timeoutMs,
        toolRetry,
        requestId,
        tenantId,
        projectId,
        userId,
      },
      ...createChatTaskHooks({ sid, runSpecId, requestId, tenantId, projectId, userId, traceId,
        provider, model, workspaceRoot, toolMode, config, resumedSession, ctx, send }),
    });

    if (scheduled.status !== 'completed') {
      return await handleNonCompletedOutcome({ scheduled, prompt, provider, model, workspaceRoot, toolMode,
        boundTodoId, sid, tenantId, projectId, userId, requestId, traceId, runSpecId, config, send, identityName });
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
