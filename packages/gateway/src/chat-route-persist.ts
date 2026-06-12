import { ensureSessionStore, saveSession, type SessionRecord } from '@los/agent/session';
import { appendSessionEvent, ensureSessionEventStore } from '@los/agent/session-events';
import { transitionExecutionState } from '@los/agent/execution-store';
import type { TodoStatus } from '@los/agent/todos';
import type { CheckpointState } from '@los/agent';
import { addObservation, ensureMemoryStore } from '@los/memory';
import { applyDirectRunCompletionStatus } from './chat-run-completion.js';
import { updateBoundTodoFromRun } from './chat-session-helpers.js';
import { completeIdempotencyKey, failIdempotencyKey } from './idempotency.js';

export async function persistChatSuccess(opts: {
  prompt: string;
  result: { text: string; loopCount: number; totalTokens: number };
  persistMemory: boolean;
  sessionId: string;
  provider: string | null;
  model: string | null;
  workspaceRoot: string;
  toolMode: string;
  boundTodoId: string | null;
  runSpecId: string;
  taskRunId: string;
  traceId: string;
  requestId: string;
  tenantId: string;
  projectId: string;
  userId: string;
  nodeId: string | null;
  idempotency: { id: string } | null;
  replayPayload: unknown;
}) {
  const postRun = await Promise.all([
    opts.persistMemory
      ? ensureMemoryStore().then(() => addObservation({
        title: `Chat session ${opts.sessionId.slice(0, 12)}`,
        summary: `Prompt: ${opts.prompt.slice(0, 200)} - ${opts.result.text.slice(0, 200)}`,
        kind: 'note',
        tags: ['chat', 'session'],
        source: 'agent',
        sessionId: opts.sessionId,
        tenantId: opts.tenantId,
        projectId: opts.projectId,
        userId: opts.userId,
        nodeId: opts.nodeId ?? undefined,
        requestId: opts.requestId,
        traceId: opts.traceId,
      }))
      : Promise.resolve(undefined),
    applyDirectRunCompletionStatus({
      runSpecId: opts.runSpecId,
      sessionId: opts.sessionId,
      tenantId: opts.tenantId,
      projectId: opts.projectId,
      userId: opts.userId,
      nodeId: opts.nodeId ?? undefined,
      requestId: opts.requestId,
      traceId: opts.traceId,
      taskRunId: opts.taskRunId,
    }).catch(() => undefined),
  ]);

  const runCompletion = postRun[1];
  const todoCompletionStatus: TodoStatus = (runCompletion?.blockedVerificationRecordIds.length ?? 0) > 0 ? 'blocked' : 'done';

  if (opts.boundTodoId) {
    await updateBoundTodoFromRun(opts.boundTodoId, {
      status: todoCompletionStatus,
      sessionId: opts.sessionId,
      taskRunId: opts.taskRunId,
      traceId: opts.traceId,
      requestId: opts.requestId,
      runSpecId: opts.runSpecId,
      event: todoCompletionStatus === 'blocked' ? 'run.verification_blocked' : 'task.succeeded',
      blockedVerificationRecordIds: runCompletion?.blockedVerificationRecordIds ?? [],
    });
  }

  if (opts.idempotency) {
    await completeIdempotencyKey(opts.idempotency.id, 200, opts.replayPayload as any);
  }

  return {
    runCompletion,
    todoCompletionStatus,
  };
}

export async function persistChatError(opts: {
  err: any;
  sessionId: string;
  taskRunId: string | null;
  traceId: string;
  requestId: string;
  tenantId: string | undefined;
  projectId: string | undefined;
  userId: string | undefined;
  activeRunSpecId: string | null;
  boundTodoId: string | null;
  lastCheckpoint: CheckpointState | null;
  resumedSession: SessionRecord | null;
  provider: string | null;
  model: string | null;
  workspaceRoot: string;
  toolMode: string;
  runSpecId: string;
  idempotency: { id: string } | null;
}) {
  if (opts.boundTodoId) {
    await updateBoundTodoFromRun(opts.boundTodoId, {
      status: 'blocked',
      sessionId: opts.sessionId,
      taskRunId: opts.taskRunId ?? undefined,
      traceId: opts.traceId,
      requestId: opts.requestId,
      runSpecId: opts.activeRunSpecId ?? undefined,
      event: 'session.error',
      reason: opts.err?.message ?? String(opts.err),
    }).catch(() => undefined);
  }

  await ensureSessionEventStore().catch(() => undefined);
  await appendSessionEvent({
    sessionId: opts.sessionId,
    tenantId: opts.tenantId,
    projectId: opts.projectId,
    userId: opts.userId,
    requestId: opts.requestId,
    traceId: opts.traceId,
    type: 'session.error',
    turn: 0,
    payload: {
      message: opts.err?.message ?? String(opts.err),
      taskRunId: opts.taskRunId ?? null,
      requestId: opts.requestId,
    },
  }).catch(() => undefined);

  await transitionExecutionState({
    entityType: 'run_spec',
    entityId: opts.runSpecId,
    to: 'failed',
    sessionId: opts.sessionId,
    reason: opts.err?.message ?? 'chat_error',
  }).catch(() => undefined);

  if (opts.lastCheckpoint) {
    await ensureSessionStore().catch(() => undefined);
    await saveSession({
      id: opts.sessionId,
      tenantId: opts.tenantId,
      projectId: opts.projectId,
      userId: opts.userId,
      requestId: opts.requestId,
      traceId: opts.traceId,
      createdAt: opts.resumedSession?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: opts.lastCheckpoint.messages,
      turns: opts.resumedSession ? [...opts.resumedSession.turns, ...opts.lastCheckpoint.turns] : opts.lastCheckpoint.turns,
      metadata: {
        ...(opts.resumedSession?.metadata ?? {}),
        provider: opts.provider ?? null,
        model: opts.model ?? null,
        workspaceRoot: opts.workspaceRoot,
        toolMode: opts.toolMode,
        error: opts.err?.message ?? String(opts.err),
      },
    }).catch(() => undefined);
  }

  if (opts.idempotency) {
    await failIdempotencyKey(opts.idempotency.id, opts.err).catch(() => undefined);
  }
}
