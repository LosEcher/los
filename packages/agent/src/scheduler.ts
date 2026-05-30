/**
 * @los/agent/scheduler — Single-process task scheduler wrapper.
 *
 * This is intentionally small: it owns task lifecycle evidence and dedupe,
 * while runAgent still owns model/tool execution.
 */

import { randomUUID } from 'node:crypto';
import { appendSessionEvent, ensureSessionEventStore } from './session-events.js';
import { runAgent, type AgentConfig, type AgentResult, type TurnSummary } from './loop.js';
import {
  createTaskRun,
  ensureTaskRunStore,
  findActiveTaskRunByDedupeKey,
  loadTaskRun,
  updateTaskRun,
  type TaskRunRecord,
} from './task-runs.js';

export type ScheduledTaskEventType =
  | 'task.created'
  | 'task.deduplicated'
  | 'task.running'
  | 'task.cancelled'
  | 'task.succeeded'
  | 'task.failed';

export interface ScheduledTaskEvent {
  type: ScheduledTaskEventType;
  taskRun: TaskRunRecord;
}

export interface ScheduledAgentTaskInput extends AgentConfig {
  prompt: string;
  taskRunId?: string;
  traceId?: string;
  dedupeKey?: string;
  timeoutMs?: number;
  promptPreview?: string;
  metadata?: Record<string, unknown>;
  onTaskEvent?: (event: ScheduledTaskEvent) => void | Promise<void>;
}

export type ScheduledAgentTaskResult =
  | {
      status: 'completed';
      sessionId: string;
      taskRun: TaskRunRecord;
      result: AgentResult;
    }
  | {
      status: 'deduplicated';
      sessionId: string;
      taskRun: TaskRunRecord;
    }
  | {
      status: 'cancelled';
      sessionId: string;
      taskRun: TaskRunRecord;
      reason: string;
    };

type RunningTaskController = {
  controller: AbortController;
  reason: string;
};

const runningTaskControllers = new Map<string, RunningTaskController>();

export async function runScheduledAgentTask(input: ScheduledAgentTaskInput): Promise<ScheduledAgentTaskResult> {
  await ensureTaskRunStore();
  await ensureSessionEventStore();

  const taskRunId = input.taskRunId ?? `task-${randomUUID()}`;
  const sessionId = input.sessionId ?? `session-${Date.now()}`;
  const traceId = input.traceId ?? taskRunId;
  const dedupeKey = normalizeOptionalString(input.dedupeKey);
  const toolMode = input.toolMode ?? 'project-write';
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const timeoutMs = normalizePositiveInteger(input.timeoutMs);

  if (dedupeKey) {
    const existing = await findActiveTaskRunByDedupeKey(dedupeKey);
    if (existing) {
      await emitTaskEvent(existing.sessionId, 'task.deduplicated', existing, {
        duplicateTaskRunId: taskRunId,
      });
      await input.onTaskEvent?.({ type: 'task.deduplicated', taskRun: existing });
      return {
        status: 'deduplicated',
        sessionId: existing.sessionId,
        taskRun: existing,
      };
    }
  }

  const created = await createTaskRun({
    id: taskRunId,
    sessionId,
    traceId,
    dedupeKey,
    workspaceRoot,
    toolMode,
    provider: input.provider,
    promptPreview: input.promptPreview ?? input.prompt.slice(0, 200),
    metadata: input.metadata ?? {},
    status: 'queued',
  });
  await emitTaskEvent(sessionId, 'task.created', created);
  await input.onTaskEvent?.({ type: 'task.created', taskRun: created });

  let running = await updateTaskRun(taskRunId, {
    status: 'running',
    metadata: {
      ...created.metadata,
      maxLoops: input.maxLoops,
      allowedTools: input.allowedTools,
      toolRetry: input.toolRetry,
      timeoutMs,
    },
  });
  running ??= await loadTaskRun(taskRunId);
  if (!running) throw new Error(`Task run disappeared after create: ${taskRunId}`);
  await emitTaskEvent(sessionId, 'task.running', running);
  await input.onTaskEvent?.({ type: 'task.running', taskRun: running });

  const controller = new AbortController();
  const linkedAbortCleanup = linkAbortSignal(input.signal, controller);
  let timeout: NodeJS.Timeout | undefined;
  runningTaskControllers.set(taskRunId, { controller, reason: 'cancelled' });
  if (timeoutMs) {
    timeout = setTimeout(() => {
      abortTaskController(taskRunId, `timeout:${timeoutMs}ms`);
    }, timeoutMs);
  }

  try {
    const result = await runAgent(input.prompt, {
      sessionId,
      provider: input.provider,
      maxLoops: input.maxLoops,
      systemPrompt: input.systemPrompt,
      workspaceRoot,
      toolMode,
      initialMessages: input.initialMessages,
      allowedTools: input.allowedTools,
      toolRetry: input.toolRetry,
      signal: controller.signal,
      onSessionEvent: input.onSessionEvent,
      onTurn: input.onTurn,
      onToolCall: input.onToolCall,
    });

    const succeeded = await updateTaskRun(taskRunId, {
      status: 'succeeded',
      metadata: {
        ...running.metadata,
        loopCount: result.loopCount,
        totalTokens: result.totalTokens,
      },
    });
    const finalTask = succeeded ?? running;
    await emitTaskEvent(sessionId, 'task.succeeded', finalTask);
    await input.onTaskEvent?.({ type: 'task.succeeded', taskRun: finalTask });
    return {
      status: 'completed',
      sessionId,
      taskRun: finalTask,
      result,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isAbortError(err)) {
      const reason = runningTaskControllers.get(taskRunId)?.reason ?? message;
      const cancelled = await updateTaskRun(taskRunId, {
        status: 'cancelled',
        metadata: {
          ...running.metadata,
          cancelReason: reason,
        },
      });
      const finalTask = cancelled ?? running;
      await emitTaskEvent(sessionId, 'task.cancelled', finalTask, { reason });
      await input.onTaskEvent?.({ type: 'task.cancelled', taskRun: finalTask });
      return {
        status: 'cancelled',
        sessionId,
        taskRun: finalTask,
        reason,
      };
    }

    const failed = await updateTaskRun(taskRunId, {
      status: 'failed',
      metadata: {
        ...running.metadata,
        error: message,
      },
    });
    const finalTask = failed ?? running;
    await emitTaskEvent(sessionId, 'task.failed', finalTask, { message });
    await input.onTaskEvent?.({ type: 'task.failed', taskRun: finalTask });
    throw err;
  } finally {
    if (timeout) clearTimeout(timeout);
    linkedAbortCleanup();
    runningTaskControllers.delete(taskRunId);
  }
}

export function cancelScheduledTask(taskRunId: string, reason = 'cancelled'): boolean {
  return abortTaskController(taskRunId, reason);
}

async function emitTaskEvent(
  sessionId: string,
  type: ScheduledTaskEventType,
  taskRun: TaskRunRecord,
  extraPayload: Record<string, unknown> = {},
): Promise<void> {
  await appendSessionEvent({
    sessionId,
    type,
    payload: {
      taskRunId: taskRun.id,
      traceId: taskRun.traceId,
      dedupeKey: taskRun.dedupeKey ?? null,
      workspaceRoot: taskRun.workspaceRoot,
      toolMode: taskRun.toolMode,
      provider: taskRun.provider ?? null,
      status: taskRun.status,
      ...extraPayload,
    },
  });
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const int = Math.floor(value);
  return int > 0 ? int : undefined;
}

function abortTaskController(taskRunId: string, reason: string): boolean {
  const running = runningTaskControllers.get(taskRunId);
  if (!running) return false;
  running.reason = reason;
  if (!running.controller.signal.aborted) {
    running.controller.abort(createAbortError(reason));
  }
  return true;
}

function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => undefined;
  if (source.aborted) {
    target.abort(source.reason);
    return () => undefined;
  }

  const onAbort = () => target.abort(source.reason);
  source.addEventListener('abort', onAbort, { once: true });
  return () => source.removeEventListener('abort', onAbort);
}

function createAbortError(reason: string): Error {
  const err = new Error(reason);
  err.name = 'AbortError';
  return err;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
