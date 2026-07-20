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
import { isWorkerBlockReason, workerBlockReasonFrom } from './worker-block-error.js';
import { clearCancellation } from '../cancellation.js';
import { canStartExecution, type RunContractMetadata } from '../run-contract.js';
import { recordSchedulerDecision } from '../scheduler-decision-ledger.js';
import {
  _ExecutorSelectionError,
  resolveExecutor,
  runAgentOnExecutor,
  type ResolvedExecutor,
} from './executor-client.js';
import { normalizeOptionalString, normalizePositiveInteger, readObject } from './helpers.js';
import { emitTaskEvent } from './task-events.js';
import { startTaskHeartbeat } from './task-heartbeat.js';
import { persistScheduledToolCallState } from './tool-call-state-persistence.js';
import { readCurrentRunContract, checkVerificationGate } from './contract-reader.js';
import {
  completePlanningDisposition,
  promptForDisposition,
  resolveTaskDisposition,
  validatePlanningDisposition,
} from './planning-disposition.js';
import { runGoalSelfCheck } from './goal-self-check-runner.js';
import { writeDeadLetterEvent } from '../dead-letter.js';
import {
  normalizeProviderFallbackPolicy,
  resolveProviderFallbackInitialTarget,
  type ProviderFallbackEvent,
} from '../providers/provider-fallback.js';
import type { SessionEventRecord } from '../session-events.js';
import type { ScheduledAgentTaskInput, ScheduledAgentTaskResult } from './types.js';

export async function runScheduledAgentTask(input: ScheduledAgentTaskInput): Promise<ScheduledAgentTaskResult> {
  await ensureTaskRunStore();
  await ensureSessionEventStore();

  const taskRunId = input.taskRunId ?? `task-${randomUUID()}`;
  const sessionId = input.sessionId ?? `session-${Date.now()}`;
  const traceId = input.traceId ?? taskRunId;
  const dedupeKey = normalizeOptionalString(input.dedupeKey);
  const contractMetadata = {
    ...(input.metadata ?? {}),
    ...(input.runContract ? { runContract: input.runContract } : {}),
  };
  const runContract = await readCurrentRunContract(input.runSpecId, contractMetadata);
  const disposition = resolveTaskDisposition(input, runContract);
  const toolMode = disposition === 'planning' ? 'read-only' : (input.toolMode ?? 'project-write');
  const sandboxMode = disposition === 'planning' ? 'readonly' : input.sandboxMode;
  const runtimePrompt = promptForDisposition(input.prompt, disposition);
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const timeoutMs = normalizePositiveInteger(input.timeoutMs);
  const leaseMs = normalizePositiveInteger(input.executor?.leaseMs) ?? 30_000;
  const heartbeatMs = normalizePositiveInteger(input.executor?.heartbeatMs) ?? Math.max(1_000, Math.floor(leaseMs / 3));
  const leaseVersion = normalizePositiveInteger(input.leaseVersion) ?? 1;
  const providerFallback = normalizeProviderFallbackPolicy(input.providerFallback);
  const initialFallbackTarget = resolveProviderFallbackInitialTarget(providerFallback, {
    provider: input.provider,
    model: input.model,
  });
  const initialProvider = initialFallbackTarget?.provider ?? input.provider;
  const initialModel = initialFallbackTarget?.model ?? input.model;

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

  let executor: ResolvedExecutor | null;
  try {
    executor = await resolveExecutor(input.executor, {
      toolMode,
      sandboxMode,
    });
  } catch (error) {
    if (error instanceof _ExecutorSelectionError) {
      const metadata = readObject(input.metadata);
      await recordSchedulerDecision({
        graphId: normalizeOptionalString(metadata.graphId) ?? input.runSpecId ?? taskRunId,
        taskId: normalizeOptionalString(metadata.agentTaskId),
        taskRunId,
        runSpecId: input.runSpecId,
        sessionId,
        kind: 'executor_selection',
        selectedIds: [],
        skipped: error.decision.skipped,
        reason: 'no_executor_match',
        metadata: {
          candidateNodeIds: error.decision.candidateIds,
          requiredCapabilities: error.decision.requiredCapabilities,
        },
      });
    }
    throw error;
  }
  const nodeId = executor?.nodeId ?? 'gateway-local';

  const created = await createTaskRun({
    id: taskRunId,
    sessionId,
    runSpecId: input.runSpecId,
    traceId,
    dedupeKey,
    workspaceRoot,
    toolMode,
    provider: initialProvider,
    model: initialModel,
    tenantId: normalizeOptionalString(input.tenantId),
    projectId: normalizeOptionalString(input.projectId),
    userId: normalizeOptionalString(input.userId),
    nodeId,
    requestId: normalizeOptionalString(input.requestId),
    promptPreview: input.promptPreview ?? input.prompt.slice(0, 200),
    metadata: input.metadata ?? {},
    runContract,
    status: 'queued',
    attempt: input.attempt,
    leaseVersion,
    leaseExpiresAt: new Date(Date.now() + leaseMs),
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
        placementTier: executor.decision.placementTier,
        requiredCapabilities: executor.decision.requiredCapabilities,
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
    leaseVersion,
  });
  let running = await updateTaskRunFields(taskRunId, {
    nodeId,
    heartbeatAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + leaseMs),
    metadata: {
      ...created.metadata,
      requestedRoute: { provider: input.provider ?? null, model: input.model ?? null },
      effectiveRoute: { provider: initialProvider ?? null, model: initialModel ?? null },
      providerFallback: providerFallback ?? null,
      providerSwitchHistory: [],
      model: initialModel,
      maxLoops: input.maxLoops,
      modelSettings: input.modelSettings,
      allowedTools: input.allowedTools,
      toolRetry: input.toolRetry,
      timeoutMs,
      disposition,
    },
    runContract,
  });
  running ??= await loadTaskRun(taskRunId);
  if (!running) throw new Error(`Task run disappeared after create: ${taskRunId}`);
  const persistProviderFallbackSelection = async (event: ProviderFallbackEvent): Promise<void> => {
    if (event.type !== 'selected' || !event.toProvider || !event.toModel) return;
    const current = running;
    if (!current) throw new Error(`Task run disappeared during provider fallback: ${taskRunId}`);
    const existingHistory = Array.isArray(current.metadata.providerSwitchHistory)
      ? current.metadata.providerSwitchHistory
      : [];
    const updated = await updateTaskRunFields(taskRunId, {
      provider: event.toProvider,
      model: event.toModel,
      metadata: {
        ...current.metadata,
        effectiveRoute: { provider: event.toProvider, model: event.toModel },
        providerSwitchHistory: [...existingHistory, {
          callIndex: event.callIndex,
          switchIndex: event.switchIndex,
          failureClass: event.failureClass,
          errorCode: event.errorCode ?? null,
          fromProvider: event.fromProvider,
          fromModel: event.fromModel,
          toProvider: event.toProvider,
          toModel: event.toModel,
          compatibilityEvidenceId: event.compatibilityEvidenceId ?? null,
        }],
      },
    });
    if (!updated) throw new Error(`Task run disappeared during provider fallback: ${taskRunId}`);
    running = updated;
  };
  const handleSessionEvent = async (event: SessionEventRecord): Promise<void> => {
    if (executor && event.type === 'provider.fallback.selected') {
      await persistProviderFallbackSelection({
        type: 'selected',
        ...event.payload,
      } as unknown as ProviderFallbackEvent);
    }
    await input.onSessionEvent?.(event);
  };
  await emitTaskEvent(sessionId, 'task.running', running);
  await input.onTaskEvent?.({ type: 'task.running', taskRun: running });
  if (input.runContract?.hooks) {
    runLifecycleHooks('afterStart', {
      hooks: input.runContract.hooks as import('../run-contract.js').TaskLifecycleHooks,
      sessionId,
      runSpecId: input.runSpecId,
      taskRunId,
    }).catch(() => undefined);
  }
  const architectEditor = runContract?.mode === 'architect-editor'
    ? { enabled: true as const }
    : undefined;
  const execCheck = disposition === 'planning'
    ? { allowed: validatePlanningDisposition(runContract) === null, reason: validatePlanningDisposition(runContract) ?? undefined }
    : canStartExecution(runContract);
  if (!execCheck.allowed) {
    await transitionExecutionState({
      entityType: 'task_run',
      entityId: taskRunId,
      to: 'blocked',
      sessionId,
      reason: execCheck.reason ?? 'b0_phase_gate',
      nodeId,
      leaseVersion,
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
  const unregisterTaskController = registerScheduledTaskController(taskRunId, controller, 'cancelled');
  const stopHeartbeat = startTaskHeartbeat(taskRunId, nodeId, leaseVersion, leaseMs, heartbeatMs, {
    dispatchId: normalizeOptionalString(input.metadata?.agentTaskAttemptId),
    taskId: input.agentTaskLease?.taskId,
    agentTaskLease: input.agentTaskLease,
  });
  if (timeoutMs) {
    timeout = setTimeout(() => {
      cancelScheduledTask(taskRunId, `timeout:${timeoutMs}ms`);
    }, timeoutMs);
  }

  try {
    const result = executor
      ? await runAgentOnExecutor(executor, {
          taskRunId,
          leaseVersion,
          agentTaskLease: input.agentTaskLease,
          leaseMs,
          prompt: runtimePrompt,
          config: {
            sessionId,
            runSpecId: input.runSpecId,
            provider: initialProvider,
            model: initialModel,
            providerFallback,
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
            sandboxMode,
            skipPreExecutionPhases: disposition === 'planning',
            architectEditor,
            taskRunId,
            dispatchId: normalizeOptionalString(input.metadata?.agentTaskAttemptId),
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
          onSessionEvent: handleSessionEvent,
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
      : await runAgent(runtimePrompt, {
          sessionId,
          runSpecId: input.runSpecId,
          provider: initialProvider,
          model: initialModel,
          providerFallback,
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
          sandboxMode,
          skipPreExecutionPhases: disposition === 'planning',
          architectEditor,
          taskRunId,
          dispatchId: normalizeOptionalString(input.metadata?.agentTaskAttemptId),
          initialMessages: input.initialMessages,
          allowedTools: input.allowedTools,
          toolRetry: input.toolRetry,
          mcpServers: input.mcpServers,
          runContractMetadata: {
            ...running.metadata,
            ...(runContract ? { runContract } : {}),
          },
          signal: controller.signal,
          onSessionEvent: handleSessionEvent,
          onProviderFallback: persistProviderFallbackSelection,
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

    if (disposition === 'planning') {
      return await completePlanningDisposition({
        schedulerInput: input,
        result,
        running,
        taskRunId,
        sessionId,
        nodeId,
        leaseVersion,
      });
    }
    const verifyContract = await readCurrentRunContract(input.runSpecId, running.metadata);
    const verifyCheck = input.verificationOwner === 'graph'
      ? { allowed: true }
      : await checkVerificationGate(input.runSpecId, verifyContract);
    if (!verifyCheck.allowed) {
      await transitionExecutionState({
        entityType: 'task_run',
        entityId: taskRunId,
        to: 'blocked',
        sessionId,
        reason: verifyCheck.reason ?? 'verification_pending',
        nodeId,
        leaseVersion,
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

    const selfCheckBlock = await runGoalSelfCheck(input, result, running, sessionId, taskRunId);
    if (selfCheckBlock) return selfCheckBlock;

    await transitionExecutionState({
      entityType: 'task_run',
      entityId: taskRunId,
      to: 'succeeded',
      sessionId,
      reason: 'task_completed',
      nodeId,
      leaseVersion,
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
      if (isWorkerBlockReason(reason)) {
        const blockReason = workerBlockReasonFrom(reason) ?? 'worker_block';
        const blocked = await updateTaskRunFields(taskRunId, {
          metadata: {
            ...running.metadata,
            blockReason,
          },
        });
        const finalBlocked = blocked ?? running;
        await emitTaskEvent(sessionId, 'task.blocked', finalBlocked, { reason: blockReason });
        await input.onTaskEvent?.({ type: 'task.blocked', taskRun: finalBlocked });
        return {
          status: 'blocked',
          sessionId,
          taskRun: finalBlocked,
          reason: blockReason,
        };
      }
      await transitionExecutionState({
        entityType: 'task_run',
        entityId: taskRunId,
        to: 'cancelled',
        sessionId,
        reason,
        nodeId,
        leaseVersion,
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
      nodeId,
      leaseVersion,
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

    if (!isAbortError(err)) {
      writeDeadLetterEvent({
        taskRunId,
        runSpecId: input.runSpecId,
        reason: finalTask.attempt && finalTask.attempt >= 3 ? 'max_attempts' : 'unrecoverable_error',
        originalError: message,
        eventPayload: {
          attempt: finalTask.attempt,
          provider: initialProvider,
          model: initialModel,
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
        provider: initialProvider,
        model: initialModel,
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
