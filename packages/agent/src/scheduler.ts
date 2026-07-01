/**
 * @los/agent/scheduler — Single-process task scheduler wrapper.
 *
 * This is intentionally small: it owns task lifecycle evidence and dedupe,
 * while runAgent still owns model/tool execution.
 */

import { randomUUID } from 'node:crypto';
import { appendSessionEvent } from './session-events.js';
import {
  claimReadyAgentTasks,
  createAgentTaskAttempt,
  ensureAgentTaskGraphStore,
  heartbeatAgentTask,
  listAgentTaskAttempts,
  updateAgentTaskStatus,
  type AgentTaskRecord,
} from './agent-task-graph.js';
import { startTaskHeartbeat } from './scheduler/task-heartbeat.js';
import {
  getAgentTaskGraphCompletion,
  type AgentTaskGraphCompletion,
} from './agent-task-graph-read-model.js';
import {
  readToolCallRecoveryForRunSpec,
  type ToolCallRecoveryDecision,
} from './tool-call-recovery.js';
import { transitionExecutionState } from './execution-store.js';
import { type RunSpecStatus } from './run-specs.js';
import { cancelScheduledTask } from './scheduler/abort-registry.js';
import {
  normalizeOptionalString,
  normalizePositiveInteger,
  previewText,
} from './scheduler/helpers.js';
import { resolveGraphTaskProviderModelSelection } from './scheduler/provider-selection.js';
import { recordSchedulerDecision } from './scheduler-decision-ledger.js';
import { maybeQueueRecoveryFollowUp } from './scheduler/recovery-follow-up.js';
import {
  listToolCallStateIdsForTaskRun,
  persistScheduledToolCallState,
} from './scheduler/tool-call-state-persistence.js';
import { runScheduledAgentTask } from './scheduler/scheduled-task-runner.js';
import { runClaimedVerifierGraphTask } from './scheduler/verifier-task.js';
import type {
  GraphTaskProviderModelSelection,
  RunAgentTaskGraphSerialInput,
  RunAgentTaskGraphSerialResult,
} from './scheduler/types.js';

export { cancelScheduledTask, persistScheduledToolCallState, runScheduledAgentTask };
export type {
  RunAgentTaskGraphSerialInput,
  RunAgentTaskGraphSerialResult,
  ScheduledAgentTaskInput,
  ScheduledAgentTaskResult,
  ScheduledExecutorConfig,
  ScheduledTaskEvent,
  ScheduledTaskEventType,
} from './scheduler/types.js';

export async function runAgentTaskGraphSerial(input: RunAgentTaskGraphSerialInput): Promise<RunAgentTaskGraphSerialResult> {
  await ensureAgentTaskGraphStore();
  if (input.runSpecId) {
    await transitionExecutionState({
      entityType: 'run_spec',
      entityId: input.runSpecId,
      to: 'running',
      reason: 'graph_serial_start',
      sessionId: input.sessionId,
      nodeId: input.nodeId,
    }).catch(() => undefined);
  }

  const maxTasks = normalizePositiveInteger(input.maxTasks) ?? 50;
  const maxParallelTasks = Math.min(maxTasks, normalizePositiveInteger(input.maxParallelTasks) ?? 1);
  const editableSurfaceMode = input.editableSurfaceMode
    ?? (maxParallelTasks > 1 ? 'require-declared' : 'exclude-overlaps');
  const claimedBy = normalizeOptionalString(input.nodeId)
    ?? normalizeOptionalString(input.executor?.nodeId)
    ?? 'gateway-local';
  const executedTasks: RunAgentTaskGraphSerialResult['executedTasks'] = [];

  while (executedTasks.length < maxTasks) {
    const remaining = maxTasks - executedTasks.length;
    const batchLimit = Math.min(remaining, maxParallelTasks);
    const tasks = await claimReadyAgentTasks({
      graphId: input.graphId,
      limit: batchLimit,
      nodeId: claimedBy,
      leaseMs: input.executor?.leaseMs,
      editableSurfaceMode,
    });
    if (tasks.length === 0) break;

    const executed = await Promise.all(tasks.map(task => runClaimedAgentGraphTask(task, input)));
    executedTasks.push(...executed);
    if (executed.some(task => task.status !== 'succeeded' && task.recoveryFollowUpQueued !== true)) break;
  }

  const completion = await getAgentTaskGraphCompletion(input.graphId, {
    requireVerifier: input.requireVerifier,
  });
  const recovery = await applyGraphCompletionRunSpecTransition(input, completion);

  return {
    graphId: input.graphId,
    executedTasks,
    completion,
    recovery,
  };
}

async function applyGraphCompletionRunSpecTransition(
  input: RunAgentTaskGraphSerialInput,
  completion: AgentTaskGraphCompletion,
): Promise<ToolCallRecoveryDecision | undefined> {
  if (!input.runSpecId) return undefined;

  const recovery = await readToolCallRecoveryForRunSpec(input.runSpecId);
  if (recovery.status === 'action_required') {
    await transitionExecutionState({
      entityType: 'run_spec',
      entityId: input.runSpecId,
      to: 'blocked',
      reason: 'recovery_action_required',
      sessionId: input.sessionId,
      nodeId: input.nodeId,
    });
    if (input.sessionId) {
      await appendSessionEvent({
        sessionId: input.sessionId,
        tenantId: input.tenantId,
        projectId: input.projectId,
        userId: input.userId,
        nodeId: input.nodeId,
        requestId: input.requestId,
        traceId: input.traceId,
        type: 'run.recovery_required',
        payload: {
          runSpecId: input.runSpecId,
          graphId: input.graphId,
          recommendation: recovery.recommendation,
          retryToolCallIds: recovery.retryToolCallIds,
          resumeToolCallIds: recovery.resumeToolCallIds,
          cancelToolCallIds: recovery.cancelToolCallIds,
          operatorAttentionToolCallIds: recovery.operatorAttentionToolCallIds,
          terminalFailedToolCallIds: recovery.terminalFailedToolCallIds,
          activeToolCallIds: recovery.activeToolCallIds,
          reasons: recovery.reasons,
          completionStatus: completion.status,
        },
      });
    }
    return recovery;
  }

  const status = runSpecStatusForGraphCompletion(completion);
  if (status) {
    await transitionExecutionState({
      entityType: 'run_spec',
      entityId: input.runSpecId,
      to: status,
      reason: `graph_completion:${completion.status}`,
      sessionId: input.sessionId,
      nodeId: input.nodeId,
    }).catch(() => undefined);
  }

  if (status === 'blocked' && input.sessionId) {
    await appendSessionEvent({
      sessionId: input.sessionId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      userId: input.userId,
      nodeId: input.nodeId,
      requestId: input.requestId,
      traceId: input.traceId,
      type: 'run.blocked',
      payload: {
        runSpecId: input.runSpecId,
        graphId: input.graphId,
        reason: completion.reason,
        requireVerifier: input.requireVerifier === true,
        completionStatus: completion.status,
        readyTaskIds: completion.readyTaskIds,
        waitingTaskIds: completion.waitingTaskIds,
        blockedTaskIds: completion.blockedTaskIds,
        failedTaskIds: completion.failedTaskIds,
        verifierTaskIds: completion.verifierTaskIds,
        succeededVerifierTaskIds: completion.succeededVerifierTaskIds,
      },
    });
  }
  return recovery;
}

function runSpecStatusForGraphCompletion(completion: AgentTaskGraphCompletion): RunSpecStatus | undefined {
  if (completion.status === 'succeeded') return 'succeeded';
  if (completion.status === 'failed') return 'failed';
  if (completion.status === 'blocked') return 'blocked';
  if (completion.status === 'in_progress') return 'running';
  return undefined;
}

async function runClaimedAgentGraphTask(
  task: AgentTaskRecord,
  input: RunAgentTaskGraphSerialInput,
): Promise<RunAgentTaskGraphSerialResult['executedTasks'][number]> {
  if (task.role === 'verifier') {
    return await runClaimedVerifierGraphTask(task, input);
  }

  const attempts = await listAgentTaskAttempts(task.id);
  const attempt = attempts.length + 1;
  const attemptId = `${task.id}-attempt-${attempt}-${randomUUID()}`;
  const taskRunId = `task-${randomUUID()}`;
  const sessionId = task.sessionId ?? input.sessionId;
  const runSpecId = task.runSpecId ?? input.runSpecId;
  const nodeId = normalizeOptionalString(input.nodeId)
    ?? normalizeOptionalString(input.executor?.nodeId)
    ?? 'gateway-local';
  let selection: GraphTaskProviderModelSelection;

  try {
    selection = await resolveGraphTaskProviderModelSelection(task, input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordSchedulerDecision({
      graphId: task.graphId,
      taskId: task.id,
      attemptId,
      taskRunId,
      runSpecId,
      sessionId,
      nodeId,
      kind: 'provider_selection',
      reason: 'provider_selection_failed',
      skipped: [{ id: task.id, reason: 'provider_capability_mismatch', details: { error: message } }],
      metadata: {
        error: message,
        taskMetadata: task.metadata,
      },
    });
    await updateAgentTaskStatus(task.id, 'failed', {
      attemptId,
      error: message,
      providerModelSelection: { error: message },
    });
    await createAgentTaskAttempt({
      id: attemptId,
      graphId: task.graphId,
      taskId: task.id,
      attempt,
      status: 'failed',
      nodeId,
      error: message,
    });
    return { taskId: task.id, attemptId, status: 'failed' };
  }

  await recordSchedulerDecision({
    graphId: task.graphId,
    taskId: task.id,
    attemptId,
    taskRunId,
    runSpecId,
    sessionId,
    nodeId,
    kind: 'provider_selection',
    selectedIds: [selection.targetLabel ?? selection.provider ?? selection.model ?? 'scheduler-default'],
    skipped: (selection.rejectedTargetLabels ?? []).map(label => ({
      id: label,
      reason: 'provider_capability_mismatch',
    })),
    reason: selection.source,
    provider: selection.provider,
    model: selection.model,
    metadata: {
      source: selection.source,
      evidenceId: selection.evidenceId,
      targetLabel: selection.targetLabel,
      requireProviderCompat: selection.requireProviderCompat === true,
    },
  });

  await createAgentTaskAttempt({
    id: attemptId,
    graphId: task.graphId,
    taskId: task.id,
    attempt,
    status: 'running',
    provider: selection.provider,
    model: selection.model,
    nodeId,
    taskRunId,
  });

  // Heartbeat the agent task lease so it doesn't expire during execution.
  // Same pattern as task-run heartbeat in startTaskHeartbeat().
  const leaseMs = normalizePositiveInteger(input.executor?.leaseMs) ?? 30_000;
  const heartbeatMs = Math.max(1_000, Math.floor(leaseMs / 3));
  const stopTaskHeartbeat = startTaskHeartbeat(task.id, nodeId, leaseMs, heartbeatMs);

  try {
    // Per Agent Identity Decision Framework: planner/executor tasks get standard
    // identity (default). Verifier tasks are handled separately above and get none.
    const result = await runScheduledAgentTask({
      ...input,
      provider: selection.provider,
      model: selection.model,
      prompt: task.prompt ?? task.title,
      promptPreview: task.title,
      taskRunId,
      runSpecId,
      sessionId,
      dedupeKey: undefined,
      metadata: {
        ...(input.metadata ?? {}),
        graphId: task.graphId,
        agentTaskId: task.id,
        agentTaskRole: task.role,
        agentTaskTitle: task.title,
        providerModelSelection: selection,
      },
    });

    if (result.status === 'cancelled') {
      await updateAgentTaskStatus(task.id, 'cancelled', {
        taskRunId,
        attemptId,
        cancelReason: result.reason,
      });
      await createAgentTaskAttempt({
        id: attemptId,
        graphId: task.graphId,
        taskId: task.id,
        attempt,
        status: 'cancelled',
        provider: selection.provider,
        model: selection.model,
        nodeId: result.taskRun.nodeId ?? nodeId,
        taskRunId,
        error: result.reason,
        toolCallStateIds: await listToolCallStateIdsForTaskRun(taskRunId),
      });
      return { taskId: task.id, taskRunId, attemptId, status: 'cancelled' };
    }

    const outputSummary = result.status === 'completed'
      ? previewText(result.result.text)
      : 'deduplicated task run';
    const recoveryFollowUp = await maybeQueueRecoveryFollowUp({
      task,
      input,
      attempt,
      attemptId,
      taskRunId,
      sessionId,
      nodeId: result.taskRun.nodeId ?? nodeId,
      selection,
      outputSummary,
    });
    if (recoveryFollowUp) return recoveryFollowUp;

    await updateAgentTaskStatus(task.id, 'succeeded', {
      taskRunId,
      attemptId,
      outputSummary,
      providerModelSelection: selection,
    });
    await createAgentTaskAttempt({
      id: attemptId,
      graphId: task.graphId,
      taskId: task.id,
      attempt,
      status: 'succeeded',
      provider: selection.provider,
      model: selection.model,
      nodeId: result.taskRun.nodeId ?? nodeId,
      taskRunId,
      outputSummary,
      toolCallStateIds: await listToolCallStateIdsForTaskRun(taskRunId),
    });
    return { taskId: task.id, taskRunId, attemptId, status: 'succeeded' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateAgentTaskStatus(task.id, 'failed', {
      taskRunId,
      attemptId,
      error: message,
      providerModelSelection: selection,
    });
    await createAgentTaskAttempt({
      id: attemptId,
      graphId: task.graphId,
      taskId: task.id,
      attempt,
      status: 'failed',
      provider: selection.provider,
      model: selection.model,
      nodeId,
      taskRunId,
      error: message,
      toolCallStateIds: await listToolCallStateIdsForTaskRun(taskRunId),
    });
    return { taskId: task.id, taskRunId, attemptId, status: 'failed' };
  } finally {
    stopTaskHeartbeat();
  }
}
