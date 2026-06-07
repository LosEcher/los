import {
  createAgentTaskAttempt,
  updateAgentTaskStatus,
  type AgentTaskRecord,
} from '../agent-task-graph.js';
import { appendSessionEvent } from '../session-events.js';
import { readToolCallRecoveryForTaskRun, type ToolCallRecoveryDecision } from '../tool-call-recovery.js';
import {
  listToolCallStatesForTaskRun,
  updateToolCallState,
  type ToolCallStateRecord,
} from '../tool-call-states.js';
import type {
  GraphTaskProviderModelSelection,
  RunAgentTaskGraphSerialInput,
  RunAgentTaskGraphSerialResult,
} from './types.js';

export async function maybeQueueRecoveryFollowUp(input: {
  task: AgentTaskRecord;
  input: RunAgentTaskGraphSerialInput;
  attempt: number;
  attemptId: string;
  taskRunId: string;
  sessionId?: string;
  nodeId: string;
  selection: GraphTaskProviderModelSelection;
  outputSummary: string;
}): Promise<RunAgentTaskGraphSerialResult['executedTasks'][number] | undefined> {
  if (input.attempt >= input.task.maxAttempts) return undefined;

  const recovery = await readToolCallRecoveryForTaskRun(input.taskRunId);
  if (recovery.status !== 'action_required') return undefined;
  if (recovery.recommendation !== 'retry' && recovery.recommendation !== 'resume') return undefined;

  const toolStates = await listToolCallStatesForTaskRun(input.taskRunId);
  const followUpToolCallIds = [...recovery.retryToolCallIds, ...recovery.resumeToolCallIds];
  const followUpToolStates = toolStates.filter(state => followUpToolCallIds.includes(state.id));
  if (followUpToolStates.length === 0) return undefined;

  await markToolStatesRetrying(followUpToolStates);
  const error = summarizeRecoveryFollowUp(recovery, input.attempt + 1, input.task.maxAttempts);
  await updateAgentTaskStatus(input.task.id, 'queued', {
    taskRunId: input.taskRunId,
    attemptId: input.attemptId,
    recoveryRecommendation: recovery.recommendation,
    recoveryFollowUpQueued: true,
    recoveryToolCallIds: followUpToolCallIds,
    recoveryReasons: recovery.reasons,
  });
  await createAgentTaskAttempt({
    id: input.attemptId,
    graphId: input.task.graphId,
    taskId: input.task.id,
    attempt: input.attempt,
    status: 'failed',
    provider: input.selection.provider,
    model: input.selection.model,
    nodeId: input.nodeId,
    taskRunId: input.taskRunId,
    outputSummary: input.outputSummary,
    error,
    toolCallStateIds: followUpToolCallIds,
  });

  if (input.sessionId) {
    await appendSessionEvent({
      sessionId: input.sessionId,
      tenantId: input.input.tenantId,
      projectId: input.input.projectId,
      userId: input.input.userId,
      nodeId: input.nodeId,
      requestId: input.input.requestId,
      traceId: input.input.traceId,
      type: 'task.recovery_followup_queued',
      payload: {
        graphId: input.task.graphId,
        taskId: input.task.id,
        taskRunId: input.taskRunId,
        attemptId: input.attemptId,
        nextAttempt: input.attempt + 1,
        maxAttempts: input.task.maxAttempts,
        recommendation: recovery.recommendation,
        retryToolCallIds: recovery.retryToolCallIds,
        resumeToolCallIds: recovery.resumeToolCallIds,
        reasons: recovery.reasons,
      },
    });
  }

  return {
    taskId: input.task.id,
    taskRunId: input.taskRunId,
    attemptId: input.attemptId,
    status: 'failed',
    recoveryFollowUpQueued: true,
  };
}

async function markToolStatesRetrying(toolStates: readonly ToolCallStateRecord[]): Promise<void> {
  await Promise.all(toolStates.map(state => updateToolCallState(state.id, state.sessionId, {
    state: 'retrying',
    outputSummary: `queued recovery follow-up attempt ${state.attempt + 1}/${state.maxAttempts}`,
    error: null,
    attempt: Math.min(state.attempt + 1, state.maxAttempts),
  })));
}

function summarizeRecoveryFollowUp(
  recovery: ToolCallRecoveryDecision,
  nextAttempt: number,
  maxAttempts: number,
): string {
  return `recovery ${recovery.recommendation} queued follow-up attempt ${nextAttempt}/${maxAttempts}: ${recovery.reasons.join('; ')}`;
}
