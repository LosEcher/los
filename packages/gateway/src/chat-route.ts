import type { FastifyInstance } from 'fastify';
import type { Config } from '@los/infra/config';
import { runScheduledAgentTask } from '@los/agent/scheduler';
import { normalizeModelSettings, type ModelSettings } from '@los/agent/model-settings';
import {
  normalizeWorkspaceRoot,
  normalizeOptionalString,
  normalizeToolMode,
  normalizeAllowedTools,
  normalizePositiveInteger,
  normalizeToolRetry,
  normalizeMCPServers,
  type ToolMode,
  type MCPRequestServer,
  type ToolRetryInput,
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
  updateRunSpecStatus,
} from '@los/agent/run-specs';
import {
  appendSessionEvent,
  ensureSessionEventStore,
} from '@los/agent/session-events';
import type { CheckpointState, RunContractMetadataInput } from '@los/agent';
import { addObservation, ensureMemoryStore } from '@los/memory';
import { applyDirectRunCompletionStatus } from './chat-run-completion.js';
import {
  completeIdempotencyKey,
  failIdempotencyKey,
  reserveIdempotentRequest,
} from './idempotency.js';
import { getRequestContext } from './request-context.js';


interface ChatRequestBody {
  prompt: string;
  sessionId?: string;
  branchFrom?: string;
  branchAtTurn?: number;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  modelSettings?: ModelSettings;
  workspaceRoot?: string;
  toolMode?: ToolMode;
  allowedTools?: string[];
  maxLoops?: number;
  traceId?: string;
  dedupeKey?: string;
  timeoutMs?: number;
  toolRetry?: ToolRetryInput;
  mcpServers?: MCPRequestServer[];
  runContract?: RunContractMetadataInput;
  persistMemory?: boolean;
  todoId?: string;
}

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
    const send = (event: string, data: unknown, id?: number) => {
      replayEvents.push({ event, data });
      if (id !== undefined) reply.raw.write(`id: ${id}\n`);
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Branch from parent session: copy messages into a new session
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
    let activeTaskRunId: string | undefined;
    let activeRunSpecId: string | undefined;
    let sentSession = false;
    let lastCheckpoint: CheckpointState | null = null;

    const resumedSession = (!branchFrom && sessionId) ? await loadSession(sid) : null;

    // Create durable run spec before execution
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
        systemPrompt,
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
        onTurn: (turn) => {
          send('turn', {
            loopCount: turn.loopCount,
            text: turn.text.slice(0, 200),
            toolCallCount: turn.toolCalls.length,
            toolNames: turn.toolCalls.map(tc => tc.function.name),
            reasoning: turn.reasoningContent?.slice(0, 200),
          });
        },
        onToolCall: (tool, args) => {
          send('tool_call', { tool, args: JSON.stringify(args).slice(0, 200) });
        },
        onModelDelta: (delta) => {
          send('model.delta', {
            turn: delta.turn,
            provider: delta.provider,
            model: delta.model ?? null,
            textDelta: delta.textDelta ?? '',
            reasoningDelta: delta.reasoningDelta ?? '',
          });
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
        onSessionEvent: (event) => {
          send(event.type, {
            id: event.id,
            sessionId: event.sessionId,
            tenantId: event.tenantId ?? null,
            projectId: event.projectId ?? null,
            userId: event.userId ?? null,
            nodeId: event.nodeId ?? null,
            requestId: event.requestId ?? null,
            traceId: event.traceId ?? null,
            turn: event.turn,
            source: event.source,
            model: event.model ?? null,
            toolName: event.toolName ?? null,
            cacheKey: event.cacheKey ?? null,
            cacheHit: event.cacheHit ?? null,
            usage: event.usage ?? null,
            payload: event.payload,
            createdAt: event.createdAt,
          }, event.id);
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
        if (idempotency) {
          await completeIdempotencyKey(idempotency.id, 200, { events: replayEvents });
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
        if (idempotency) {
          await completeIdempotencyKey(idempotency.id, 200, { events: replayEvents });
        }
        reply.raw.end();
        return;
      }

      const result = scheduled.result;
      const taskRunId = scheduled.taskRun.id;

      await ensureSessionStore();
      await saveSession({
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
      });

      if (persistMemory) {
        await ensureMemoryStore();
        await addObservation({
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
        });
      }

      const runCompletion = await applyDirectRunCompletionStatus({
        runSpecId,
        sessionId: sid,
        tenantId: context.tenantId,
        projectId: context.projectId,
        userId: context.userId,
        nodeId: scheduled.taskRun.nodeId,
        requestId: context.requestId,
        traceId: scheduled.taskRun.traceId,
        taskRunId,
      }).catch(() => undefined);
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
        await completeIdempotencyKey(idempotency.id, 200, { events: replayEvents });
      }
    } catch (err: any) {
      if (boundTodoId) {
        await updateBoundTodoFromRun(boundTodoId, {
          status: 'blocked',
          sessionId: sid,
          taskRunId: activeTaskRunId,
          traceId,
          requestId: context.requestId,
          runSpecId: activeRunSpecId,
          event: 'session.error',
          reason: err?.message ?? String(err),
        }).catch(() => undefined);
      }
      await ensureSessionEventStore().catch(() => undefined);
      await appendSessionEvent({
        sessionId: sid,
        tenantId: context.tenantId,
        projectId: context.projectId,
        userId: context.userId,
        requestId: context.requestId,
        traceId,
        type: 'session.error',
        turn: 0,
        payload: {
          message: err?.message ?? String(err),
          taskRunId: activeTaskRunId ?? null,
          requestId: context.requestId,
        },
      }).catch(() => undefined);
      await updateRunSpecStatus(runSpecId, 'failed').catch(() => undefined);
      send('error', { message: err?.message ?? String(err) });

      // Save partial session state if we have a checkpoint
      if (lastCheckpoint) {
        // TS can't track assignment inside onCheckpoint callback, but it's guaranteed
        // to be set before we reach catch if any checkpoint was emitted.
        const cp = lastCheckpoint as CheckpointState;
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
          messages: cp.messages,
          turns: resumedSession ? [...resumedSession.turns, ...cp.turns] : cp.turns,
          metadata: {
            ...(resumedSession?.metadata ?? {}),
            provider: provider ?? config.agent.defaultProvider,
            model: model ?? null,
            workspaceRoot,
            toolMode,
            error: err?.message ?? String(err),
          },
        }).catch(() => undefined);
      }

      if (idempotency) {
        await failIdempotencyKey(idempotency.id, err).catch(() => undefined);
      }
    }

    reply.raw.end();
  });
}
