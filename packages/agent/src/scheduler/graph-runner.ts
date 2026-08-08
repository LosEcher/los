import { appendSessionEvent } from '../session-events.js';
import { getLogger } from '@los/infra/logger';
import { claimReadyAgentTasks, ensureAgentTaskGraphStore } from '../agent-task-graph.js';
import {
  getAgentTaskGraphCompletion,
  type AgentTaskGraphCompletion,
} from '../agent-task-graph-read-model.js';
import {
  readToolCallRecoveryForRunSpec,
  type ToolCallRecoveryDecision,
} from '../tool-call-recovery.js';
import { _RunSuccessGateError, transitionExecutionState } from '../execution-store.js';
import { ensureRunSpecVerificationPhase } from '../run-phase-transitions.js';
import type { RunSpecStatus } from '../run-specs.js';
import { linkAbortSignal } from './abort-registry.js';
import { normalizeOptionalString, normalizePositiveInteger } from './helpers.js';
import { resumeBlockedTaskRunsWithAnswers } from './resume-tasks.js';
import { runClaimedAgentGraphTask } from './graph-task-runner.js';
import type { RunAgentTaskGraphSerialInput, RunAgentTaskGraphSerialResult } from './types.js';

const log = getLogger('agent-graph-runner');

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
    });
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

    if (tasks.length === 0) {
      const resumed = await resumeBlockedTaskRunsWithAnswers(input, batchLimit);
      if (resumed.length === 0) break;
      executedTasks.push(...resumed);
      if (resumed.some(task => task.status !== 'succeeded')) break;
      continue;
    }

    const completedStages = executedTasks
      .map(task => task.stageOutput)
      .filter((stage): stage is NonNullable<typeof stage> => Boolean(stage));

    // Graph fail-fast: when a batch worker fails (and is not a queued recovery
    // follow-up), abort the batch so running sibling workers are cancelled
    // instead of burning compute on a graph that is already failed. External
    // cancellation (input.signal) keeps propagating through the batch signal.
    const batchController = new AbortController();
    const unlinkExternalSignal = linkAbortSignal(input.signal, batchController);
    let firstFailure: { taskId: string; status: string } | null = null;
    try {
      const executed = await Promise.all(tasks.map(async task => {
        const result = await runClaimedAgentGraphTask(task, {
          ...input,
          signal: batchController.signal,
        }, completedStages);
        if (
          firstFailure === null
          && result.status !== 'succeeded'
          && result.recoveryFollowUpQueued !== true
        ) {
          firstFailure = { taskId: task.id, status: result.status };
          // Abort with an AbortError so downstream handlers (isAbortError /
          // abortErrorFromSignal) classify the sibling cancellation correctly.
          const abortError = new Error(`sibling_failed:${task.id}:${result.status}`);
          abortError.name = 'AbortError';
          batchController.abort(abortError);
          if (input.sessionId) {
            try {
              await appendSessionEvent({
                sessionId: input.sessionId,
                tenantId: input.tenantId,
                projectId: input.projectId,
                userId: input.userId,
                nodeId: input.nodeId,
                requestId: input.requestId,
                traceId: input.traceId,
                type: 'agent_graph.sibling_failed',
                payload: {
                  graphId: input.graphId,
                  failedTaskId: task.id,
                  status: result.status,
                  // Batch siblings at abort time; those still running are
                  // cancelled, already-finished ones are unaffected.
                  siblingTaskIds: tasks.filter(t => t.id !== task.id).map(t => t.id),
                  reason: `fail-fast: ${result.status} in batch`,
                },
              });
            } catch (err) {
              // Event emission must never escalate a worker failure into a
              // graph-level exception.
              log.warn(`agent_graph.sibling_failed event failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
        return result;
      }));
      executedTasks.push(...executed);
      if (executed.some(task => task.status !== 'succeeded' && task.recoveryFollowUpQueued !== true)) break;
    } finally {
      unlinkExternalSignal();
    }
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

  let status = runSpecStatusForGraphCompletion(completion);
  if (status) {
    try {
      if (status === 'succeeded') {
        await ensureRunSpecVerificationPhase(input.runSpecId, `graph_completion:${completion.status}`, 'los.scheduler');
      }
      await transitionExecutionState({
        entityType: 'run_spec',
        entityId: input.runSpecId,
        to: status,
        reason: `graph_completion:${completion.status}`,
        sessionId: input.sessionId,
        nodeId: input.nodeId,
      });
    } catch (error) {
      if (!(error instanceof _RunSuccessGateError) || status !== 'succeeded') throw error;
      status = 'blocked';
      await transitionExecutionState({
        entityType: 'run_spec',
        entityId: input.runSpecId,
        to: status,
        reason: error.message,
        sessionId: input.sessionId,
        nodeId: input.nodeId,
      });
    }
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
