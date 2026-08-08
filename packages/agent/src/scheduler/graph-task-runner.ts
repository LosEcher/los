import { randomUUID } from 'node:crypto';
import { resolveIdentityLevelForExecutionPath } from '../identity-loader.js';
import {
  createAgentTaskAttempt,
  listAgentTaskAttempts,
  updateAgentTaskStatus,
  type AgentTaskRecord,
} from '../agent-task-graph.js';
import { _LeaseLostError } from '../execution-store.js';
import { recordSchedulerDecision } from '../scheduler-decision-ledger.js';
import { workspaceRootForTask } from '../managed-workspaces.js';
import { sendWorkerMessage } from '../worker-messages.js';
import { normalizeOptionalString, previewText } from './helpers.js';
import { resolveGraphTaskProviderModelSelection } from './provider-selection.js';
import { maybeQueueRecoveryFollowUp } from './recovery-follow-up.js';
import { runScheduledAgentTask } from './scheduled-task-runner.js';
import { listToolCallStateIdsForTaskRun } from './tool-call-state-persistence.js';
import { runClaimedVerifierGraphTask } from './verifier-task.js';
import type {
  GraphTaskProviderModelSelection,
  RunAgentTaskGraphSerialInput,
  RunAgentTaskGraphSerialResult,
} from './types.js';

export async function runClaimedAgentGraphTask(
  task: AgentTaskRecord,
  input: RunAgentTaskGraphSerialInput,
  completedStages: ReadonlyArray<NonNullable<RunAgentTaskGraphSerialResult['executedTasks'][number]['stageOutput']>>,
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
  const leaseFence = { nodeId, leaseVersion: task.leaseVersion };
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
    await updateClaimedAgentTaskStatus(task, nodeId, 'failed', {
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
    await sendWorkerMessage({
      dispatchId: attemptId,
      taskId: task.id,
      type: 'worker_done',
      payload: { error: message },
    }).catch(() => undefined);
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

  try {
    const prompt = input.resolveTaskPrompt
      ? await input.resolveTaskPrompt(task, completedStages)
      : task.prompt ?? task.title;
    // The worker inherits the parent run spec contract, whose goal covers the
    // whole graph. Override the self-check contract so the post-execution
    // gate judges this worker against its own task prompt (see
    // ScheduledAgentTaskInput.selfCheckContract).
    const workerSelfCheckContract = input.runContract
      ? { ...input.runContract, goal: prompt, stopConditions: [] }
      : undefined;
    const result = await runScheduledAgentTask({
      ...input,
      workspaceRoot: workspaceRootForTask(task, input.workspaceRoot),
      identity: input.identity ?? {
        name: 'default',
        level: resolveIdentityLevelForExecutionPath('scheduler-graph'),
      },
      provider: selection.provider,
      model: selection.model,
      prompt,
      promptPreview: task.title,
      taskRunId,
      leaseVersion: task.leaseVersion,
      agentTaskLease: { taskId: task.id, leaseVersion: task.leaseVersion },
      runSpecId,
      sessionId,
      // Batch-level abort signal: a failed sibling cancels running workers
      // (graph fail-fast), and external cancellation propagates to workers.
      signal: input.signal,
      verificationOwner: input.requireVerifier ? 'graph' : 'task',
      selfCheckContract: workerSelfCheckContract,
      dedupeKey: undefined,
      metadata: {
        ...(input.metadata ?? {}),
        graphId: task.graphId,
        agentTaskId: task.id,
        agentTaskAttemptId: attemptId,
        agentTaskRole: task.role,
        agentTaskTitle: task.title,
        providerModelSelection: selection,
      },
    });

    if (result.status === 'cancelled') {
      // Attribute sibling-cancellations: the batch abort reason (AbortError
      // message) carries which sibling failed; prefer it over the generic
      // registry default 'cancelled'.
      const signalReason = input.signal?.reason instanceof Error && input.signal.reason.name === 'AbortError'
        ? input.signal.reason.message
        : undefined;
      const cancelReason = (result.reason && result.reason !== 'cancelled')
        ? result.reason
        : (signalReason ?? result.reason);
      await updateClaimedAgentTaskStatus(task, nodeId, 'cancelled', {
        taskRunId,
        attemptId,
        cancelReason,
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
        error: cancelReason,
        toolCallStateIds: await listToolCallStateIdsForTaskRun(taskRunId),
      });
      await sendWorkerMessage({
        dispatchId: attemptId,
        taskId: task.id,
        type: 'worker_done',
        payload: { error: cancelReason ?? 'cancelled' },
      }).catch(() => undefined);
      return { taskId: task.id, taskRunId, attemptId, status: 'cancelled' };
    }

    if (result.status === 'blocked') {
      const blockReason = result.reason ?? 'worker_block';
      await updateClaimedAgentTaskStatus(task, nodeId, 'blocked', {
        taskRunId,
        attemptId,
        blockReason,
      });
      await createAgentTaskAttempt({
        id: attemptId,
        graphId: task.graphId,
        taskId: task.id,
        attempt,
        status: 'failed',
        provider: selection.provider,
        model: selection.model,
        nodeId: result.taskRun.nodeId ?? nodeId,
        taskRunId,
        error: `blocked: ${blockReason}`,
        toolCallStateIds: await listToolCallStateIdsForTaskRun(taskRunId),
      });
      return { taskId: task.id, taskRunId, attemptId, status: 'failed' };
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
      leaseFence,
    });
    if (recoveryFollowUp) {
      await sendWorkerMessage({
        dispatchId: attemptId,
        taskId: task.id,
        type: 'worker_done',
        payload: { error: 'recovery_followup_queued', summary: outputSummary },
      }).catch(() => undefined);
      return recoveryFollowUp;
    }

    await updateClaimedAgentTaskStatus(task, nodeId, 'succeeded', {
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
    await sendWorkerMessage({
      dispatchId: attemptId,
      taskId: task.id,
      type: 'worker_done',
      payload: { summary: outputSummary },
    }).catch(() => undefined);
    return {
      taskId: task.id,
      taskRunId,
      attemptId,
      status: 'succeeded',
      stageOutput: result.status === 'completed' ? {
        taskId: task.id,
        title: task.title,
        outputText: result.result.text,
        provider: result.taskRun.provider,
        model: result.taskRun.model,
        promptTokens: result.result.totalTokens.prompt,
        completionTokens: result.result.totalTokens.completion,
      } : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateClaimedAgentTaskStatus(task, nodeId, 'failed', {
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
    await sendWorkerMessage({
      dispatchId: attemptId,
      taskId: task.id,
      type: 'worker_done',
      payload: { error: message },
    }).catch(() => undefined);
    return { taskId: task.id, taskRunId, attemptId, status: 'failed' };
  }
}

async function updateClaimedAgentTaskStatus(
  task: AgentTaskRecord,
  nodeId: string,
  status: Parameters<typeof updateAgentTaskStatus>[1],
  metadata: Record<string, unknown>,
): Promise<AgentTaskRecord> {
  const updated = await updateAgentTaskStatus(task.id, status, metadata, {
    nodeId,
    leaseVersion: task.leaseVersion,
  });
  if (!updated) throw new _LeaseLostError('agent_task', task.id);
  return updated;
}
