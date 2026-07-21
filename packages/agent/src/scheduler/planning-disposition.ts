import { transitionExecutionState } from '../execution-store.js';
import type { AgentResult } from '../loop.js';
import { buildPlanningPrompt, parsePlanningOutput } from '../planning-output.js';
import type { RunContractMetadata } from '../run-contract.js';
import { persistRunSpecPlan } from '../run-spec-plans.js';
import { updateTaskRunFields, type TaskRunRecord } from '../task-runs.js';
import { emitTaskEvent } from './task-events.js';
import type { ScheduledAgentTaskInput, ScheduledAgentTaskResult } from './types.js';

export type ScheduledTaskDisposition = 'planning' | 'execution';

export function resolveTaskDisposition(
  input: ScheduledAgentTaskInput,
  contract: RunContractMetadata | undefined,
): ScheduledTaskDisposition {
  return input.disposition ?? (contract?.phase === 'planning' ? 'planning' : 'execution');
}

export function promptForDisposition(prompt: string, disposition: ScheduledTaskDisposition): string {
  return disposition === 'planning' ? buildPlanningPrompt(prompt) : prompt;
}

export function validatePlanningDisposition(contract: RunContractMetadata | undefined): string | null {
  return contract?.phase === 'planning'
    ? null
    : `Planning disposition requires phase 'planning', received '${contract?.phase ?? 'created'}'.`;
}

export async function completePlanningDisposition(input: {
  schedulerInput: ScheduledAgentTaskInput;
  result: AgentResult;
  running: TaskRunRecord;
  taskRunId: string;
  sessionId: string;
  nodeId: string;
  leaseVersion: number;
}): Promise<ScheduledAgentTaskResult> {
  const runSpecId = input.schedulerInput.runSpecId;
  if (!runSpecId) throw new Error('Planning disposition requires a persisted run spec');
  const planning = parsePlanningOutput(input.result.text);
  const runSpec = await persistRunSpecPlan(runSpecId, {
    plan: planning.plan,
    verifications: planning.verifications,
    summary: planning.summary,
    actor: input.nodeId,
  });
  await transitionExecutionState({
    entityType: 'task_run',
    entityId: input.taskRunId,
    to: 'blocked',
    sessionId: input.sessionId,
    reason: 'planning_awaiting_approval',
    nodeId: input.nodeId,
    leaseVersion: input.leaseVersion,
  });
  const blocked = await updateTaskRunFields(input.taskRunId, {
    metadata: {
      ...input.running.metadata,
      disposition: 'planning',
      awaitingApproval: true,
      planRevision: runSpec.runContract?.planRevision ?? 1,
      planStepCount: planning.plan.length,
      loopCount: input.result.loopCount,
      totalTokens: input.result.totalTokens,
    },
  });
  const finalTask = blocked ?? input.running;
  await emitTaskEvent(input.sessionId, 'task.blocked', finalTask, {
    reason: 'planning_awaiting_approval',
  });
  await input.schedulerInput.onTaskEvent?.({ type: 'task.blocked', taskRun: finalTask });
  return {
    status: 'awaiting_approval',
    sessionId: input.sessionId,
    taskRun: finalTask,
    result: input.result,
    planRevision: runSpec.runContract?.planRevision ?? 1,
    planStepCount: planning.plan.length,
  };
}
