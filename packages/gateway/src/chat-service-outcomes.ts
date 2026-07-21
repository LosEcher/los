import type { Config } from '@los/infra/config';
import type { ScheduledAgentTaskResult } from '@los/agent/scheduler';
import { ensureSessionStore, saveSession } from '@los/agent/session';
import { updateBoundTodoFromRun } from './chat-session-helpers.js';
import type { ChatResult } from './chat-service.js';
import type { SendEvent } from './chat-live-events.js';

export async function handleNonCompletedOutcome(input: {
  scheduled: Exclude<ScheduledAgentTaskResult, { status: 'completed' }>;
  prompt: string;
  provider: string | undefined;
  model: string | undefined;
  workspaceRoot: string;
  toolMode: string;
  boundTodoId: string | undefined;
  sid: string;
  tenantId: string;
  projectId: string;
  userId: string;
  requestId: string;
  traceId: string;
  runSpecId: string;
  config: Config;
  send: SendEvent;
  identityName: string | undefined;
}): Promise<ChatResult> {
  const { scheduled, provider, model, config, send } = input;
  if (scheduled.status === 'awaiting_approval') {
    await ensureSessionStore();
    await saveSession({
      id: scheduled.sessionId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      userId: input.userId,
      requestId: input.requestId,
      traceId: scheduled.taskRun.traceId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: scheduled.result.messages,
      turns: scheduled.result.turns,
      metadata: {
        provider: provider ?? config.agent.defaultProvider,
        model: scheduled.taskRun.model ?? model ?? null,
        workspaceRoot: input.workspaceRoot,
        toolMode: 'read-only',
        taskRunId: scheduled.taskRun.id,
        runSpecId: input.runSpecId,
        disposition: 'planning',
        awaitingApproval: true,
      },
    });
    send('awaiting_approval', {
      sessionId: scheduled.sessionId,
      runSpecId: input.runSpecId,
      taskRunId: scheduled.taskRun.id,
      traceId: scheduled.taskRun.traceId,
      planRevision: scheduled.planRevision,
      planStepCount: scheduled.planStepCount,
    });
    send('done', {
      text: scheduled.result.text,
      awaitingApproval: true,
      sessionId: scheduled.sessionId,
      runSpecId: input.runSpecId,
      taskRunId: scheduled.taskRun.id,
    });
    return {
      status: 'awaiting_approval',
      sessionId: scheduled.sessionId,
      taskRunId: scheduled.taskRun.id,
      traceId: scheduled.taskRun.traceId,
    };
  }
  if (scheduled.status === 'deduplicated') {
    send('deduplicated', {
      sessionId: scheduled.sessionId, taskRunId: scheduled.taskRun.id, traceId: scheduled.taskRun.traceId,
      requestId: input.requestId, dedupeKey: scheduled.taskRun.dedupeKey ?? null, status: scheduled.taskRun.status,
    });
    send('done', { deduplicated: true, sessionId: scheduled.sessionId, taskRunId: scheduled.taskRun.id });
    await ensureSessionStore().catch(() => undefined);
    await saveSession({
      id: scheduled.sessionId, tenantId: input.tenantId, projectId: input.projectId, userId: input.userId,
      requestId: input.requestId, traceId: input.traceId, createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), messages: [], turns: [], metadata: {
        provider: provider ?? config.agent.defaultProvider, model: model ?? null, workspaceRoot: input.workspaceRoot,
        toolMode: input.toolMode, deduplicated: true, dedupeKey: scheduled.taskRun.dedupeKey ?? null,
      },
    }).catch(() => undefined);
    return { status: 'deduplicated', sessionId: scheduled.sessionId, taskRunId: scheduled.taskRun.id, traceId: scheduled.taskRun.traceId };
  }

  if (scheduled.status === 'cancelled') {
    if (input.boundTodoId) await updateBoundTodoFromRun(input.boundTodoId, {
      status: 'cancelled', sessionId: scheduled.sessionId, taskRunId: scheduled.taskRun.id,
      traceId: scheduled.taskRun.traceId, requestId: input.requestId, runSpecId: input.runSpecId,
      event: 'task.cancelled', reason: scheduled.reason,
    });
    send('cancelled', {
      sessionId: scheduled.sessionId, taskRunId: scheduled.taskRun.id, traceId: scheduled.taskRun.traceId,
      requestId: input.requestId, dedupeKey: scheduled.taskRun.dedupeKey ?? null, reason: scheduled.reason,
    });
    send('done', { cancelled: true, sessionId: scheduled.sessionId, taskRunId: scheduled.taskRun.id, reason: scheduled.reason });
    await ensureSessionStore().catch(() => undefined);
    await saveSession({
      id: scheduled.sessionId, tenantId: input.tenantId, projectId: input.projectId, userId: input.userId,
      requestId: input.requestId, traceId: input.traceId, createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), messages: [], turns: [], metadata: {
        provider: provider ?? config.agent.defaultProvider, model: model ?? null, workspaceRoot: input.workspaceRoot,
        toolMode: input.toolMode, cancelled: true, cancelReason: scheduled.reason, prompt: input.prompt,
      },
    }).catch(() => undefined);
    return { status: 'cancelled', sessionId: scheduled.sessionId, taskRunId: scheduled.taskRun.id,
      traceId: scheduled.taskRun.traceId, cancelReason: scheduled.reason };
  }

  try {
    const { recordSelfReflection } = await import('@los/memory');
    const reflectionMeta = (scheduled.taskRun.metadata as Record<string, unknown> | undefined)?.reflection as
      { summary?: string } | undefined;
    if (reflectionMeta?.summary) await recordSelfReflection({
      agentIdentity: input.identityName ?? 'default', insight: reflectionMeta.summary, confidence: 0.7,
      evidenceSessionIds: [input.sid], category: 'weakness', sessionId: input.sid,
      tenantId: input.tenantId, projectId: input.projectId,
    });
  } catch { /* self-reflection is best-effort */ }
  send('blocked', {
    sessionId: scheduled.sessionId, taskRunId: scheduled.taskRun.id, traceId: scheduled.taskRun.traceId,
    requestId: input.requestId, reason: scheduled.reason,
  });
  return { status: 'blocked', sessionId: scheduled.sessionId, taskRunId: scheduled.taskRun.id,
    traceId: scheduled.taskRun.traceId, cancelReason: scheduled.reason };
}
