import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:path';
import type { Config } from '@los/infra/config';
import { runScheduledAgentTask } from '@los/agent/scheduler';
import { ensureSessionStore, loadSession, saveSession } from '@los/agent/session';
import { listTaskRunsForSession, type TaskRunRecord } from '@los/agent/task-runs';
import {
  appendSessionEvent,
  ensureSessionEventStore,
  listRecentSessionEvents,
  type SessionEventRecord,
} from '@los/agent/session-events';
import { addObservation, ensureMemoryStore } from '@los/memory';
import {
  completeIdempotencyKey,
  failIdempotencyKey,
  reserveIdempotentRequest,
} from './idempotency.js';
import { getRequestContext } from './request-context.js';

type ToolMode = 'all' | 'project-write' | 'read-only';

interface ChatRequestBody {
  prompt: string;
  sessionId?: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  workspaceRoot?: string;
  toolMode?: ToolMode;
  allowedTools?: string[];
  maxLoops?: number;
  traceId?: string;
  dedupeKey?: string;
  timeoutMs?: number;
  toolRetry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
  persistMemory?: boolean;
}

export function registerChatRoute(app: FastifyInstance, config: Config, defaultWorkspaceRoot: string): void {
  app.post('/chat', async (req, reply) => {
    const body = req.body as ChatRequestBody;
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const sessionId = normalizeOptionalString(body.sessionId);
    const systemPrompt = normalizeOptionalString(body.systemPrompt);
    const provider = normalizeOptionalString(body.provider);
    const model = normalizeOptionalString(body.model);
    const workspaceRoot = normalizeWorkspaceRoot(body.workspaceRoot, defaultWorkspaceRoot);
    const toolMode = normalizeToolMode(body.toolMode);
    const allowedTools = normalizeAllowedTools(body.allowedTools);
    const maxLoops = normalizePositiveInteger(body.maxLoops);
    const context = getRequestContext(req);
    const traceId = normalizeOptionalString(body.traceId) ?? context.traceId;
    const dedupeKey = normalizeOptionalString(body.dedupeKey);
    const timeoutMs = normalizePositiveInteger(body.timeoutMs);
    const toolRetry = normalizeToolRetry(body.toolRetry);
    const persistMemory = body.persistMemory === true;

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
    const send = (event: string, data: unknown) => {
      replayEvents.push({ event, data });
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const sid = sessionId ?? `session-${Date.now()}`;
    let activeTaskRunId: string | undefined;
    let sentSession = false;

    try {
      const resumedSession = sessionId ? await loadSession(sid) : null;
      const resumeState = resumedSession ? await loadResumeState(sid) : null;
      if (resumedSession) {
        send('session.resumed', {
          sessionId: sid,
          messageCount: resumedSession.messages.length,
          turnCount: resumedSession.turns.length,
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

      const scheduled = await runScheduledAgentTask({
        prompt,
        sessionId: sid,
        provider,
        model,
        systemPrompt,
        workspaceRoot,
        toolMode,
        initialMessages: resumedSession?.messages,
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
        executor: {
          enabled: config.executor.enabled,
          nodeUrls: config.executor.meshNodes,
          agentKey: config.executor.agentKey,
          nodeId: config.executor.nodeId,
        },
        metadata: {
          maxLoops: maxLoops ?? config.agent.maxLoops,
          model,
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
          });
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

      send('done', {
        text: result.text,
        turns: result.loopCount,
        tokens: result.totalTokens,
        sessionId: sid,
        taskRunId,
        traceId: scheduled.taskRun.traceId,
        requestId: context.requestId,
        nodeId: scheduled.taskRun.nodeId ?? null,
      });
      if (idempotency) {
        await completeIdempotencyKey(idempotency.id, 200, { events: replayEvents });
      }
    } catch (err: any) {
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
      send('error', { message: err?.message ?? String(err) });
      if (idempotency) {
        await failIdempotencyKey(idempotency.id, err).catch(() => undefined);
      }
    }

    reply.raw.end();
  });
}

function normalizeReplayEvents(value: unknown): Array<{ event: string; data: unknown }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const events = (value as { events?: unknown }).events;
  if (!Array.isArray(events)) return [];
  return events.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const event = (entry as { event?: unknown }).event;
    if (typeof event !== 'string' || !event.trim()) return [];
    return [{ event, data: (entry as { data?: unknown }).data ?? {} }];
  });
}

async function loadResumeState(sessionId: string) {
  const [taskRuns, recentEvents] = await Promise.all([
    listTaskRunsForSession(sessionId, 10),
    listRecentSessionEvents(sessionId, 50),
  ]);
  const compactTasks = taskRuns.map(summarizeTaskRunForResume);
  const compactEvents = recentEvents.map(summarizeEventForResume);
  return {
    recentTaskRuns: compactTasks,
    activeTaskRuns: compactTasks.filter(task => task.status === 'queued' || task.status === 'running'),
    lastTaskRun: compactTasks[0] ?? null,
    recentEvents: compactEvents,
    recentEventCount: compactEvents.length,
    lastEventId: compactEvents.at(-1)?.id ?? null,
  };
}

function summarizeTaskRunForResume(task: TaskRunRecord): Record<string, unknown> {
  return {
    id: task.id,
    status: task.status,
    traceId: task.traceId,
    dedupeKey: task.dedupeKey ?? null,
    nodeId: task.nodeId ?? null,
    requestId: task.requestId ?? null,
    provider: task.provider ?? null,
    model: task.model ?? null,
    startedAt: task.startedAt ?? null,
    completedAt: task.completedAt ?? null,
    heartbeatAt: task.heartbeatAt ?? null,
    leaseExpiresAt: task.leaseExpiresAt ?? null,
    updatedAt: task.updatedAt,
  };
}

function summarizeEventForResume(event: SessionEventRecord): Record<string, unknown> {
  return {
    id: event.id,
    type: event.type,
    turn: event.turn,
    source: event.source,
    model: event.model ?? null,
    toolName: event.toolName ?? null,
    payload: event.payload,
    createdAt: event.createdAt,
  };
}

function normalizeWorkspaceRoot(value: unknown, defaultWorkspaceRoot: string): string {
  if (typeof value !== 'string') return defaultWorkspaceRoot;
  const trimmed = value.trim();
  return trimmed ? resolve(trimmed) : defaultWorkspaceRoot;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeToolMode(value: unknown): ToolMode {
  if (value === 'read-only' || value === 'project-write' || value === 'all') return value;
  return 'project-write';
}

function normalizeAllowedTools(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools = value
    .map(item => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean);
  return tools.length > 0 ? [...new Set(tools)] : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return undefined;
    const int = Math.floor(parsed);
    return int > 0 ? int : undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const int = Math.floor(value);
  return int > 0 ? int : undefined;
}

function normalizeToolRetry(value: unknown): ChatRequestBody['toolRetry'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  return {
    maxAttempts: normalizePositiveInteger(raw.maxAttempts),
    baseDelayMs: normalizeNonNegativeInteger(raw.baseDelayMs),
    maxDelayMs: normalizeNonNegativeInteger(raw.maxDelayMs),
  };
}

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return undefined;
    const int = Math.floor(parsed);
    return int >= 0 ? int : undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const int = Math.floor(value);
  return int >= 0 ? int : undefined;
}
