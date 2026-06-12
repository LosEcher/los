import type { FastifyInstance } from 'fastify';
import type { Config } from '@los/infra/config';
import { runScheduledAgentTask } from '@los/agent/scheduler';
import { normalizeModelSettings } from '@los/agent/model-settings';
import {
  normalizeWorkspaceRoot,
  normalizeOptionalString,
  normalizeToolMode,
  normalizeAllowedTools,
  normalizePositiveInteger,
  normalizeToolRetry,
  normalizeMCPServers,
} from './chat-normalizers.js';
import { ensureSessionStore, loadSession, saveSession } from '@los/agent/session';
import type { Message } from '@los/agent';
import {
  normalizeReplayEvents,
  loadResumeState,
  updateBoundTodoFromRun,
  loadBranchSource,
} from './chat-session-helpers.js';
import { type TodoStatus } from '@los/agent/todos';
import {
  ensureRunSpecStore,
  createRunSpec,
} from '@los/agent/run-specs';
import {
  appendSessionEvent,
  ensureSessionEventStore,
} from '@los/agent/session-events';
import { persistStreamCheckpoint } from './chat-stream-persist.js';
import type { CheckpointState } from '@los/agent';
import { addObservation, ensureMemoryStore } from '@los/memory';
import { augmentChatSystemPrompt } from './chat-memory-augment.js';
import { applyDirectRunCompletionStatus } from './chat-run-completion.js';
import { persistChatError } from './chat-route-persist.js';
import {
  completeIdempotencyKey,
  reserveIdempotentRequest,
} from './idempotency.js';
import { getRequestContext } from './request-context.js';
import type { ChatRequestBody } from './chat-route-types.js';
import {
  emitRunningToolCallUpsert,
  emitToolCallUpsertFromSessionEvent,
  relaySessionEvent,
} from './chat-live-events.js';

export function registerChatRoute(app: FastifyInstance, config: Config, defaultWorkspaceRoot: string, gatewayServiceId?: string): void {
  app.post('/chat', async (req, reply) => {
    const body = req.body as ChatRequestBody;
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const sessionId = normalizeOptionalString(body.sessionId);
    const systemPrompt = normalizeOptionalString(body.systemPrompt);
    const provider = normalizeOptionalString(body.provider);
    const model = normalizeOptionalString(body.model);
    const modelSettings = normalizeModelSettings(body.modelSettings);
    const workspaceRoot = normalizeWorkspaceRoot(body.workspaceRoot, defaultWorkspaceRoot);
    const toolMode = normalizeToolMode(body.toolMode);
    const allowedTools = normalizeAllowedTools(body.allowedTools);
    const maxLoops = normalizePositiveInteger(body.maxLoops);
    const context = getRequestContext(req);
    const traceId = normalizeOptionalString(body.traceId) ?? context.traceId;
    const dedupeKey = normalizeOptionalString(body.dedupeKey);
    const timeoutMs = normalizePositiveInteger(body.timeoutMs);
    const toolRetry = normalizeToolRetry(body.toolRetry);
    const mcpServers = normalizeMCPServers(body.mcpServers);
    const persistMemory = body.persistMemory === true;
    const boundTodoId = normalizeOptionalString(body.todoId);
    const branchFrom = normalizeOptionalString(body.branchFrom);
    const branchAtTurn = typeof body.branchAtTurn === 'number' && body.branchAtTurn > 0
      ? Math.floor(body.branchAtTurn)
      : undefined;

    if (!prompt) {
      return reply.status(400).send({ error: 'prompt is required' });
    }

    const idempotency = await reserveIdempotentRequest(req, {
      route: '/chat',
      method: 'POST',
      body,
      context,
    });
    if (idempotency?.status === 'body_mismatch') {
      return reply.status(409).send({
        error: 'idempotency key body mismatch',
        requestId: context.requestId,
        idempotencyKey: idempotency.idempotencyKey,
      });
    }
    if (idempotency?.status === 'processing') {
      return reply.status(409).send({
        error: 'idempotency key is already processing',
        requestId: context.requestId,
        idempotencyKey: idempotency.idempotencyKey,
      });
    }
    if (idempotency?.status === 'replayed') {
      reply.raw.writeHead(idempotency.responseStatus ?? 200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Idempotency-Key': idempotency.idempotencyKey,
        'X-Idempotency-Status': 'replayed',
      });
      for (const event of normalizeReplayEvents(idempotency.responseJson)) {
        reply.raw.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
      }
      reply.raw.end();
      return;
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(idempotency ? {
        'X-Idempotency-Key': idempotency.idempotencyKey,
        'X-Idempotency-Status': idempotency.status,
      } : {}),
    });

    const replayEvents: Array<{ event: string; data: unknown }> = [];
    const cappedReplay = () => replayEvents.slice(-500);
    const send = (event: string, data: unknown, id?: number) => {
      replayEvents.push({ event, data });
      if (id !== undefined) reply.raw.write(`id: ${id}\n`);
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let branchSourceMessages: Message[] | null = null;
    let branchParentForEvent: Awaited<ReturnType<typeof loadSession>> | null = null;
    if (branchFrom) {
      const result = await loadBranchSource(branchFrom, branchAtTurn);
      if ('error' in result) {
        send('error', { message: result.error });
        reply.raw.end();
        return;
      }
      branchSourceMessages = result.messages;
      branchParentForEvent = result.parent;
    }

    const sid = branchFrom
      ? `session-${Date.now()}`       // branch always creates a new session
      : (sessionId ?? `session-${Date.now()}`);
    let activeTaskRunId: string | undefined, activeRunSpecId: string | undefined, sentSession = false, lastCheckpoint: CheckpointState | null = null;

    const resumedSession = (!branchFrom && sessionId) ? await loadSession(sid) : null;

    await ensureRunSpecStore();
    const runSpecId = `run-${sid}-${Date.now()}`;
    activeRunSpecId = runSpecId;
    await createRunSpec({
      id: runSpecId,
      sessionId: sid,
      tenantId: context.tenantId,
      projectId: context.projectId,
      userId: context.userId,
      requestId: context.requestId,
      traceId,
      prompt,
      systemPrompt,
      provider,
      model,
      modelSettings: (modelSettings ?? {}) as Record<string, unknown>,
      workspaceRoot,
      toolMode,
      allowedTools: allowedTools ?? [],
      toolRetry: (toolRetry ?? {}) as Record<string, unknown>,
      maxLoops: maxLoops ?? config.agent.maxLoops,
      timeoutMs,
      mcpServers,
      runContract: body.runContract,
      gatewayId: gatewayServiceId,
    });
    if (boundTodoId) {
      await updateBoundTodoFromRun(boundTodoId, {
        status: 'in_progress',
        sessionId: sid,
        traceId,
        requestId: context.requestId,
        runSpecId,
        event: 'run_spec.created',
      }).catch(() => undefined);
    }
    const effectiveSystemPrompt = await augmentChatSystemPrompt({
      systemPrompt,
      toolMode,
      sessionId: sid,
      runSpecId,
      tenantId: context.tenantId,
      projectId: context.projectId,
    });
    try {
      const resumeState = resumedSession ? await loadResumeState(sid) : null;
      if (resumedSession) {
        const turnPreviews = resumedSession.turns.map(t => ({
          loop: t.loopCount,
          text: t.text.slice(0, 100),
          tools: t.toolCalls.map(tc => tc.function.name),
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

      const scheduled = await runScheduledAgentTask({
        prompt,
        sessionId: sid,
        runSpecId,
        provider,
        model,
        modelSettings,
        systemPrompt: effectiveSystemPrompt,
        workspaceRoot,
        toolMode,
        initialMessages: branchSourceMessages ?? resumedSession?.messages,
        allowedTools,
        maxLoops,
        traceId,
        dedupeKey,
        tenantId: context.tenantId,
        projectId: context.projectId,
        userId: context.userId,
        requestId: context.requestId,
        timeoutMs,
        toolRetry,
        mcpServers,
        runContract: body.runContract,
        log: context.log,
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
          requestId: context.requestId,
          tenantId: context.tenantId,
          projectId: context.projectId,
          userId: context.userId,
        },
        onTaskEvent: (event) => {
          activeTaskRunId = event.taskRun.id;
          if (!sentSession && event.type !== 'task.deduplicated') {
            sentSession = true;
            send('session', {
              sessionId: event.taskRun.sessionId,
              taskRunId: event.taskRun.id,
              traceId: event.taskRun.traceId,
              requestId: context.requestId,
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
            requestId: context.requestId,
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
            toolNames: turn.toolCalls.map(tc => tc.function.name),
            reasoning: turn.reasoningContent?.slice(0, 200),
          });
          await persistStreamCheckpoint({ sessionId: sid, runSpecId, eventType: 'turn', turn: turn.loopCount, payload: { loopCount: turn.loopCount, textPreview: turn.text.slice(0, 500), toolCallCount: turn.toolCalls.length, toolNames: turn.toolCalls.map(tc => tc.function.name) } });
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
          await persistStreamCheckpoint({ sessionId: sid, runSpecId, eventType: 'model.delta', turn: delta.turn, payload: { provider: delta.provider, model: delta.model ?? null, textDelta: delta.textDelta ?? '', reasoningDelta: delta.reasoningDelta ?? '' } });
        },
        onCheckpoint: async (state) => {
          lastCheckpoint = state;
          await ensureSessionStore().catch(() => undefined);
          await saveSession({
            id: sid,
            tenantId: context.tenantId,
            projectId: context.projectId,
            userId: context.userId,
            requestId: context.requestId,
            traceId,
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

      if (scheduled.status === 'deduplicated') {
        send('deduplicated', {
          sessionId: scheduled.sessionId,
          taskRunId: scheduled.taskRun.id,
          traceId: scheduled.taskRun.traceId,
          requestId: context.requestId,
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
          id: scheduled.sessionId,
          tenantId: context.tenantId,
          projectId: context.projectId,
          userId: context.userId,
          requestId: context.requestId,
          traceId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: [],
          turns: [],
          metadata: {
            provider: provider ?? config.agent.defaultProvider,
            model: model ?? null,
            workspaceRoot,
            toolMode,
            deduplicated: true,
            dedupeKey: scheduled.taskRun.dedupeKey ?? null,
          },
        }).catch(() => undefined);
        if (idempotency) {
          await completeIdempotencyKey(idempotency.id, 200, { events: cappedReplay() });
        }
        reply.raw.end();
        return;
      }

      if (scheduled.status === 'cancelled') {
        if (boundTodoId) {
          await updateBoundTodoFromRun(boundTodoId, {
            status: 'cancelled',
            sessionId: scheduled.sessionId,
            taskRunId: scheduled.taskRun.id,
            traceId: scheduled.taskRun.traceId,
            requestId: context.requestId,
            runSpecId,
            event: 'task.cancelled',
            reason: scheduled.reason,
          });
        }
        send('cancelled', {
          sessionId: scheduled.sessionId,
          taskRunId: scheduled.taskRun.id,
          traceId: scheduled.taskRun.traceId,
          requestId: context.requestId,
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
          id: scheduled.sessionId,
          tenantId: context.tenantId,
          projectId: context.projectId,
          userId: context.userId,
          requestId: context.requestId,
          traceId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: [],
          turns: [],
          metadata: {
            provider: provider ?? config.agent.defaultProvider,
            model: model ?? null,
            workspaceRoot,
            toolMode,
            cancelled: true,
            cancelReason: scheduled.reason,
            prompt,
          },
        }).catch(() => undefined);
        if (idempotency) {
          await completeIdempotencyKey(idempotency.id, 200, { events: cappedReplay() });
        }
        reply.raw.end();
        return;
      }

      const result = scheduled.result;
      const taskRunId = scheduled.taskRun.id;

      await ensureSessionStore();
      const postRun = await Promise.all([
        saveSession({
          id: sid,
          tenantId: context.tenantId,
          projectId: context.projectId,
          userId: context.userId,
          nodeId: scheduled.taskRun.nodeId,
          requestId: context.requestId,
          traceId: scheduled.taskRun.traceId,
          createdAt: resumedSession?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: result.messages,
          turns: resumedSession ? [...resumedSession.turns, ...result.turns] : result.turns,
          metadata: {
            ...(resumedSession?.metadata ?? {}),
            provider: provider ?? config.agent.defaultProvider,
            model: scheduled.taskRun.model ?? model ?? null,
            modelSettings: modelSettings ?? null,
            workspaceRoot,
            toolMode,
            allowedTools,
            maxLoops: maxLoops ?? config.agent.maxLoops,
            timeoutMs,
            toolRetry,
            taskRunId,
            traceId: scheduled.taskRun.traceId,
            requestId: context.requestId,
            tenantId: context.tenantId,
            projectId: context.projectId,
            userId: context.userId,
            nodeId: scheduled.taskRun.nodeId ?? null,
            dedupeKey: scheduled.taskRun.dedupeKey ?? null,
            resumed: Boolean(resumedSession),
            resumeMessageCount: resumedSession?.messages.length ?? 0,
            resumeLastTaskRunId: resumeState?.lastTaskRun?.id ?? null,
            resumeLastTaskStatus: resumeState?.lastTaskRun?.status ?? null,
            resumeLastEventId: resumeState?.lastEventId ?? null,
          },
        }),
        persistMemory
          ? ensureMemoryStore().then(() => addObservation({
              title: `Chat session ${sid.slice(0, 12)}`,
              summary: `Prompt: ${prompt.slice(0, 200)} - ${result.text.slice(0, 200)}`,
              kind: 'note',
              tags: ['chat', 'session'],
              source: 'agent',
              sessionId: sid,
              tenantId: context.tenantId,
              projectId: context.projectId,
              userId: context.userId,
              nodeId: scheduled.taskRun.nodeId,
              requestId: context.requestId,
              traceId: scheduled.taskRun.traceId,
            }))
          : Promise.resolve(undefined),
        applyDirectRunCompletionStatus({
          runSpecId,
          sessionId: sid,
          tenantId: context.tenantId,
          projectId: context.projectId,
          userId: context.userId,
          nodeId: scheduled.taskRun.nodeId,
          requestId: context.requestId,
          traceId: scheduled.taskRun.traceId,
          taskRunId,
        }).catch(() => undefined),
      ]);

      const runCompletion = postRun[2];
      const todoCompletionStatus: TodoStatus = (runCompletion?.blockedVerificationRecordIds.length ?? 0) > 0 ? 'blocked' : 'done';
      if (boundTodoId) {
        await updateBoundTodoFromRun(boundTodoId, {
          status: todoCompletionStatus,
          sessionId: sid,
          taskRunId,
          traceId: scheduled.taskRun.traceId,
          requestId: context.requestId,
          runSpecId,
          event: todoCompletionStatus === 'blocked' ? 'run.verification_blocked' : 'task.succeeded',
          blockedVerificationRecordIds: runCompletion?.blockedVerificationRecordIds ?? [],
        });
      }

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
        requestId: context.requestId,
        nodeId: scheduled.taskRun.nodeId ?? null,
      });
      if (idempotency) {
        await completeIdempotencyKey(idempotency.id, 200, { events: cappedReplay() });
      }
    } catch (err: any) {
      await persistChatError({
        err,
        sessionId: sid,
        taskRunId: activeTaskRunId ?? null,
        traceId,
        requestId: context.requestId,
        tenantId: context.tenantId,
        projectId: context.projectId,
        userId: context.userId,
        activeRunSpecId: activeRunSpecId,
        boundTodoId: boundTodoId ?? null,
        lastCheckpoint: lastCheckpoint as CheckpointState | null,
        resumedSession: resumedSession,
        provider: provider ?? config.agent.defaultProvider,
        model: model ?? null,
        workspaceRoot,
        toolMode,
        runSpecId,
        idempotency: idempotency ? { id: idempotency.id } : null,
      });
      send('error', { message: err?.message ?? String(err) });
    }

    reply.raw.end();
  });
}
