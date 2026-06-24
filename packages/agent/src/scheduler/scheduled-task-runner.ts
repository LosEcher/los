import { randomUUID } from 'node:crypto';
import { ensureSessionEventStore } from '../session-events.js';
import { runAgent } from '../loop.js';
import { recordFailoverEval } from '../run-evals.js';
import {
  createTaskRun,
  ensureTaskRunStore,
  findActiveTaskRunByDedupeKey,
  loadTaskRun,
  updateTaskRunFields,
} from '../task-runs.js';
import { transitionExecutionState } from '../execution-store.js';
import { runLifecycleHooks } from '../lifecycle-hooks.js';
import {
  cancelScheduledTask,
  getScheduledTaskAbortReason,
  isAbortError,
  linkAbortSignal,
  registerScheduledTaskController,
} from './abort-registry.js';
import { clearCancellation } from '../cancellation.js';
import { canStartExecution, type RunContractMetadata } from '../run-contract.js';
import { recordSchedulerDecision } from '../scheduler-decision-ledger.js';
import { resolveExecutor, runAgentOnExecutor } from './executor-client.js';
import { normalizeOptionalString, normalizePositiveInteger, readObject } from './helpers.js';
import { emitTaskEvent } from './task-events.js';
import { startTaskHeartbeat } from './task-heartbeat.js';
import { persistScheduledToolCallState } from './tool-call-state-persistence.js';
import { readCurrentRunContract, checkVerificationGate } from './contract-reader.js';
import { runGoalSelfCheck } from './goal-self-check-runner.js';
import { writeDeadLetterEvent } from '../dead-letter.js';
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
  if (executor) {
    const metadata = readObject(input.metadata);
    await recordSchedulerDecision({
      graphId: normalizeOptionalString(metadata.graphId) ?? input.runSpecId ?? taskRunId,
      taskId: normalizeOptionalString(metadata.agentTaskId),
      taskRunId,
      runSpecId: input.runSpecId,
      sessionId,
      nodeId,
      kind: 'executor_selection',
      selectedIds: [executor.nodeId],
      skipped: executor.decision.skipped,
      reason: executor.decision.source,
      metadata: {
        candidateNodeIds: executor.decision.candidateIds,
        executorUrl: executor.url,
      },
    });
  }
  await emitTaskEvent(sessionId, 'task.created', created);
  await input.onTaskEvent?.({ type: 'task.created', taskRun: created });

  await transitionExecutionState({
    entityType: 'task_run',
    entityId: taskRunId,
    to: 'running',
    sessionId,
    reason: 'task_started',
    nodeId,
  });
  let running = await updateTaskRunFields(taskRunId, {
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

  // Execute afterStart lifecycle hooks (non-blocking)
  if (input.runContract?.hooks) {
    runLifecycleHooks('afterStart', {
      hooks: input.runContract.hooks as import('../run-contract.js').TaskLifecycleHooks,
      sessionId,
      runSpecId: input.runSpecId,
      taskRunId,
    }).catch(() => undefined);
  }

  // B0: enforce phase contract — no execution without approved plan
  const runContract = await readCurrentRunContract(input.runSpecId, running.metadata);
  // Architect/Editor activation bridge: a run contract with mode='architect-editor'
  // triggers the dual-model loop (architect plans, editor executes). Provider/model
  // overrides may be added later via contract metadata; defaults use the run's
  // provider for both roles. See loop/architect-phase.ts and ADR 0007.
  const architectEditor = runContract?.mode === 'architect-editor'
    ? { enabled: true as const }
    : undefined;
  const execCheck = canStartExecution(runContract);
  if (!execCheck.allowed) {
    await transitionExecutionState({
      entityType: 'task_run',
      entityId: taskRunId,
      to: 'blocked',
      sessionId,
      reason: execCheck.reason ?? 'b0_phase_gate',
    });
    await updateTaskRunFields(taskRunId, {
      metadata: { ...running.metadata, blockReason: execCheck.reason },
    });
    await emitTaskEvent(sessionId, 'task.blocked', { ...running, status: 'blocked' });
    throw new Error(`Execution blocked: ${execCheck.reason}`);
  }

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
            identity: input.identity,
            workspaceRoot,
            tenantId: input.tenantId,
            projectId: input.projectId,
            userId: input.userId,
            nodeId,
            requestId: input.requestId,
            traceId,
            toolMode,
            sandboxMode: input.sandboxMode,
            architectEditor,
            initialMessages: input.initialMessages,
            allowedTools: input.allowedTools,
            toolRetry: input.toolRetry,
            mcpServers: input.mcpServers,
            runContractMetadata: {
              ...running.metadata,
              ...(runContract ? { runContract } : {}),
            },
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
          identity: input.identity,
          workspaceRoot,
          tenantId: input.tenantId,
          projectId: input.projectId,
          userId: input.userId,
          nodeId,
          requestId: input.requestId,
          traceId,
          log: input.log,
          toolMode,
          sandboxMode: input.sandboxMode,
          architectEditor,
          initialMessages: input.initialMessages,
          allowedTools: input.allowedTools,
          toolRetry: input.toolRetry,
          mcpServers: input.mcpServers,
          runContractMetadata: {
            ...running.metadata,
            ...(runContract ? { runContract } : {}),
          },
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
          contextMonitor: input.contextMonitor,
        });

    // B0: enforce phase contract — no succeeded while verification pending/failed
    const verifyContract = await readCurrentRunContract(input.runSpecId, running.metadata);
    // Load verification record statuses for this run spec
    const verifyCheck = await checkVerificationGate(input.runSpecId, verifyContract);
    if (!verifyCheck.allowed) {
      await transitionExecutionState({
        entityType: 'task_run',
        entityId: taskRunId,
        to: 'blocked',
        sessionId,
        reason: verifyCheck.reason ?? 'verification_pending',
      });
      const blocked = await updateTaskRunFields(taskRunId, {
        metadata: {
          ...running.metadata,
          blockReason: verifyCheck.reason,
          loopCount: result.loopCount,
          totalTokens: result.totalTokens,
        },
      });
      const finalBlocked = blocked ?? running;
      await emitTaskEvent(sessionId, 'task.blocked', finalBlocked);
      await input.onTaskEvent?.({ type: 'task.blocked', taskRun: finalBlocked });
      return {
        status: 'blocked',
        sessionId,
        taskRun: { ...finalBlocked, status: 'blocked' },
        result,
        reason: verifyCheck.reason ?? 'verification pending',
      };
    }

    // B0: post-execution goal self-check — evaluate output against declared goal and stop conditions
    const selfCheckBlock = await runGoalSelfCheck(input, result, running, sessionId, taskRunId);
    if (selfCheckBlock) return selfCheckBlock;

    await transitionExecutionState({
      entityType: 'task_run',
      entityId: taskRunId,
      to: 'succeeded',
      sessionId,
      reason: 'task_completed',
    });
    const succeeded = await updateTaskRunFields(taskRunId, {
      metadata: {
        ...running.metadata,
        loopCount: result.loopCount,
        totalTokens: result.totalTokens,
      },
    });
    const finalTask = succeeded ?? running;
    await emitTaskEvent(sessionId, 'task.succeeded', finalTask);
    await input.onTaskEvent?.({ type: 'task.succeeded', taskRun: finalTask });

    // Execute afterFinish lifecycle hooks (non-blocking)
    if (input.runContract?.hooks) {
      runLifecycleHooks('afterFinish', {
        hooks: input.runContract.hooks as any,
        sessionId,
        runSpecId: input.runSpecId,
        taskRunId,
      }).catch(() => undefined);
    }

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
      await transitionExecutionState({
        entityType: 'task_run',
        entityId: taskRunId,
        to: 'cancelled',
        sessionId,
        reason,
      });
      const cancelled = await updateTaskRunFields(taskRunId, {
        metadata: {
          ...running.metadata,
          cancelReason: reason,
        },
      });
      const finalTask = cancelled ?? running;
      await emitTaskEvent(sessionId, 'task.cancelled', finalTask, { reason });
      await input.onTaskEvent?.({ type: 'task.cancelled', taskRun: finalTask });
      if (input.runContract?.hooks) {
        runLifecycleHooks('afterFinish', {
          hooks: input.runContract.hooks as any,
          sessionId,
          runSpecId: input.runSpecId,
          taskRunId,
        }).catch(() => undefined);
      }
      return {
        status: 'cancelled',
        sessionId,
        taskRun: finalTask,
        reason,
      };
    }

    await transitionExecutionState({
      entityType: 'task_run',
      entityId: taskRunId,
      to: 'failed',
      sessionId,
      reason: message,
    });
    const failed = await updateTaskRunFields(taskRunId, {
      metadata: {
        ...running.metadata,
        error: message,
      },
      attempt: (running.attempt ?? 0) + 1,
    });
    const finalTask = failed ?? running;
    await emitTaskEvent(sessionId, 'task.failed', finalTask, { message });
    await input.onTaskEvent?.({ type: 'task.failed', taskRun: finalTask });

    // Write to dead-letter queue for unrecoverable errors (non-abort failures)
    if (!isAbortError(err)) {
      writeDeadLetterEvent({
        taskRunId,
        runSpecId: input.runSpecId,
        reason: finalTask.attempt && finalTask.attempt >= 3 ? 'max_attempts' : 'unrecoverable_error',
        originalError: message,
        eventPayload: {
          attempt: finalTask.attempt,
          provider: input.provider,
          model: input.model,
          sessionId,
          promptPreview: input.promptPreview,
        },
      }).catch(() => undefined);
    }

    if (input.runContract?.hooks) {
      runLifecycleHooks('afterFinish', {
        hooks: input.runContract.hooks as any,
        sessionId,
        runSpecId: input.runSpecId,
        taskRunId,
      }).catch(() => undefined);
    }

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
    clearCancellation(taskRunId).catch(() => undefined);
  }
}  // end runScheduledAgentTask
