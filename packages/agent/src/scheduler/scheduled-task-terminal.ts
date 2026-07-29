import { writeDeadLetterEvent } from '../dead-letter.js';
import { transitionExecutionState } from '../execution-store.js';
import { runLifecycleHooks } from '../lifecycle-hooks.js';
import { recordTaskOutcome } from '../scheduler-decision-ledger.js';
import type { AgentResult } from '../loop.js';
import { recordFailoverEval } from '../run-evals.js';
import { updateTaskRunFields, type TaskRunRecord } from '../task-runs.js';
import {
  getScheduledTaskAbortReason,
  isAbortError,
} from './abort-registry.js';
import { checkVerificationGate, readCurrentRunContract } from './contract-reader.js';
import type { ResolvedExecutor } from './executor-client.js';
import { runGoalSelfCheck } from './goal-self-check-runner.js';
import { emitTaskEvent } from './task-events.js';
import { completePlanningDisposition } from './planning-disposition.js';
import { isWorkerBlockReason, workerBlockReasonFrom } from './worker-block-error.js';
import type { ScheduledAgentTaskInput, ScheduledAgentTaskResult } from './types.js';

interface ScheduledTaskTerminalContext {
  input: ScheduledAgentTaskInput;
  running: TaskRunRecord;
  taskRunId: string;
  sessionId: string;
  nodeId: string;
  leaseVersion: number;
  disposition: 'planning' | 'execution';
  initialProvider?: string;
  initialModel?: string;
  executor: ResolvedExecutor | null;
}

export async function completeScheduledTask(
  result: AgentResult,
  context: ScheduledTaskTerminalContext,
): Promise<ScheduledAgentTaskResult> {
  const { input, running, taskRunId, sessionId, nodeId, leaseVersion, disposition, initialProvider, initialModel } = context;
  if (disposition === 'planning') {
    return await completePlanningDisposition({
      schedulerInput: input,
      result,
      running,
      taskRunId,
      sessionId,
      nodeId,
      leaseVersion,
      planningTransport: input.planningTransport ?? 'typed_tool',
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
        blockKind: 'verification',
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
  runAfterFinishHooks(input, sessionId, taskRunId);
  recordTaskOutcome({
    taskRunId,
    runSpecId: input.runSpecId,
    sessionId,
    provider: initialProvider ?? 'unknown',
    model: initialModel ?? 'unknown',
    status: 'succeeded',
    durationMs: result.durationMs ?? 0,
    totalTokens: (result.totalTokens?.prompt ?? 0) + (result.totalTokens?.completion ?? 0),
    loopCount: result.loopCount,
  }).catch(() => undefined);

  return {
    status: 'completed',
    sessionId,
    taskRun: finalTask,
    result,
  };
}

export async function handleScheduledTaskError(
  error: unknown,
  context: ScheduledTaskTerminalContext,
): Promise<ScheduledAgentTaskResult> {
  const {
    input,
    running,
    taskRunId,
    sessionId,
    nodeId,
    leaseVersion,
    initialProvider,
    initialModel,
    executor,
  } = context;
  const message = error instanceof Error ? error.message : String(error);
  if (isAbortError(error)) {
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
    runAfterFinishHooks(input, sessionId, taskRunId);
    recordTaskOutcome({
      taskRunId,
      runSpecId: input.runSpecId,
      sessionId,
      provider: initialProvider ?? 'unknown',
      model: initialModel ?? 'unknown',
      status: 'cancelled',
      durationMs: 0,
      error: reason,
    }).catch(() => undefined);
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
  runAfterFinishHooks(input, sessionId, taskRunId);
  recordTaskOutcome({
    taskRunId,
    runSpecId: input.runSpecId,
    sessionId,
    provider: initialProvider ?? 'unknown',
    model: initialModel ?? 'unknown',
    status: 'failed',
    durationMs: 0,
    error: message,
  }).catch(() => undefined);

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
  throw error;
}

function runAfterFinishHooks(input: ScheduledAgentTaskInput, sessionId: string, taskRunId: string): void {
  if (!input.runContract?.hooks) return;
  runLifecycleHooks('afterFinish', {
    hooks: input.runContract.hooks as import('../run-contract.js').TaskLifecycleHooks,
    sessionId,
    runSpecId: input.runSpecId,
    taskRunId,
  }).catch(() => undefined);
}
