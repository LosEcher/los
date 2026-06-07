import { randomUUID } from 'node:crypto';
import { ensureSessionEventStore } from '../session-events.js';
import { runAgent } from '../loop.js';
import { recordFailoverEval } from '../run-evals.js';
import {
  createTaskRun,
  ensureTaskRunStore,
  findActiveTaskRunByDedupeKey,
  loadTaskRun,
  updateTaskRun,
} from '../task-runs.js';
import {
  cancelScheduledTask,
  getScheduledTaskAbortReason,
  isAbortError,
  linkAbortSignal,
  registerScheduledTaskController,
} from './abort-registry.js';
import { resolveExecutor, runAgentOnExecutor } from './executor-client.js';
import { normalizeOptionalString, normalizePositiveInteger } from './helpers.js';
import { emitTaskEvent } from './task-events.js';
import { startTaskHeartbeat } from './task-heartbeat.js';
import { persistScheduledToolCallState } from './tool-call-state-persistence.js';
import type { ScheduledAgentTaskInput, ScheduledAgentTaskResult } from './types.js';

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
  const executor = await resolveExecutor(input.executor);
  const nodeId = executor?.nodeId ?? 'gateway-local';
  const leaseMs = normalizePositiveInteger(input.executor?.leaseMs) ?? 30_000;
  const heartbeatMs = normalizePositiveInteger(input.executor?.heartbeatMs) ?? Math.max(1_000, Math.floor(leaseMs / 3));

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
    runSpecId: input.runSpecId,
    traceId,
    dedupeKey,
    workspaceRoot,
    toolMode,
    provider: input.provider,
    model: input.model,
    tenantId: normalizeOptionalString(input.tenantId),
    projectId: normalizeOptionalString(input.projectId),
    userId: normalizeOptionalString(input.userId),
    nodeId,
    requestId: normalizeOptionalString(input.requestId),
    promptPreview: input.promptPreview ?? input.prompt.slice(0, 200),
    metadata: input.metadata ?? {},
    runContract: input.runContract,
    status: 'queued',
  });
  await emitTaskEvent(sessionId, 'task.created', created);
  await input.onTaskEvent?.({ type: 'task.created', taskRun: created });

  let running = await updateTaskRun(taskRunId, {
    status: 'running',
    nodeId,
    heartbeatAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + leaseMs),
    metadata: {
      ...created.metadata,
      model: input.model,
      maxLoops: input.maxLoops,
      modelSettings: input.modelSettings,
      allowedTools: input.allowedTools,
      toolRetry: input.toolRetry,
      timeoutMs,
    },
    runContract: input.runContract,
  });
  running ??= await loadTaskRun(taskRunId);
  if (!running) throw new Error(`Task run disappeared after create: ${taskRunId}`);
  await emitTaskEvent(sessionId, 'task.running', running);
  await input.onTaskEvent?.({ type: 'task.running', taskRun: running });

  const controller = new AbortController();
  const linkedAbortCleanup = linkAbortSignal(input.signal, controller);
  let timeout: NodeJS.Timeout | undefined;
  const stopHeartbeat = startTaskHeartbeat(taskRunId, nodeId, leaseMs, heartbeatMs);
  const unregisterTaskController = registerScheduledTaskController(taskRunId, controller, 'cancelled');
  if (timeoutMs) {
    timeout = setTimeout(() => {
      cancelScheduledTask(taskRunId, `timeout:${timeoutMs}ms`);
    }, timeoutMs);
  }

  try {
    const result = executor
      ? await runAgentOnExecutor(executor, {
          taskRunId,
          leaseMs,
          prompt: input.prompt,
          config: {
            sessionId,
            provider: input.provider,
            model: input.model,
            modelSettings: input.modelSettings,
            maxLoops: input.maxLoops,
            systemPrompt: input.systemPrompt,
            workspaceRoot,
            tenantId: input.tenantId,
            projectId: input.projectId,
            userId: input.userId,
            nodeId,
            requestId: input.requestId,
            traceId,
            toolMode,
            initialMessages: input.initialMessages,
            allowedTools: input.allowedTools,
            toolRetry: input.toolRetry,
            mcpServers: input.mcpServers,
          },
          signal: controller.signal,
          onSessionEvent: input.onSessionEvent,
          onModelDelta: input.onModelDelta,
          onToolCallState: async (transition) => {
            await persistScheduledToolCallState({
              transition,
              sessionId,
              runSpecId: input.runSpecId,
              taskRunId,
            });
            await input.onToolCallState?.(transition);
          },
          onCheckpoint: input.onCheckpoint,
        })
      : await runAgent(input.prompt, {
          sessionId,
          provider: input.provider,
          model: input.model,
          modelSettings: input.modelSettings,
          maxLoops: input.maxLoops,
          systemPrompt: input.systemPrompt,
          workspaceRoot,
          tenantId: input.tenantId,
          projectId: input.projectId,
          userId: input.userId,
          nodeId,
          requestId: input.requestId,
          traceId,
          toolMode,
          initialMessages: input.initialMessages,
          allowedTools: input.allowedTools,
          toolRetry: input.toolRetry,
          mcpServers: input.mcpServers,
          signal: controller.signal,
          onSessionEvent: input.onSessionEvent,
          onTurn: input.onTurn,
          onToolCall: input.onToolCall,
          onToolCallState: async (transition) => {
            await persistScheduledToolCallState({
              transition,
              sessionId,
              runSpecId: input.runSpecId,
              taskRunId,
            });
            await input.onToolCallState?.(transition);
          },
          onModelDelta: input.onModelDelta,
          onCheckpoint: input.onCheckpoint,
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
      const reason = getScheduledTaskAbortReason(taskRunId) ?? message;
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

    if (executor && input.runSpecId) {
      await recordFailoverEval({
        runSpecId: input.runSpecId,
        sessionId,
        taskRunId,
        provider: input.provider,
        model: input.model,
        failureClass: 'executor_failure',
        failoverScope: 'executor',
        errorMessage: message,
      });
    }

    throw err;
  } finally {
    if (timeout) clearTimeout(timeout);
    stopHeartbeat();
    linkedAbortCleanup();
    unregisterTaskController();
  }
}
