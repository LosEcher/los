/**
 * @los/agent/scheduler/resume-tasks — resume blocked task_runs whose `ask` was answered.
 *
 * Extracted from scheduler.ts to keep that file under the 600-line CI block gate.
 */

import { transitionExecutionState } from '../execution-store.js';
import { loadAgentTask } from '../agent-task-graph.js';
import { claimBlockedTaskRunsWithAnswer } from '../task-runs/blocked-resume.js';
import { runScheduledAgentTask } from './scheduled-task-runner.js';
import { buildResumeMessage } from './resume-messages.js';
import type {
  RunAgentTaskGraphSerialInput,
  RunAgentTaskGraphSerialResult,
} from './types.js';

/**
 * Resume blocked task_runs whose `ask` worker message has been answered.
 *
 * For each claimed blocked task_run:
 *   1. transition the original task_run blocked → cancelled (reason: resumed_with_answer)
 *      — createTaskRun does not support upsert, so resume creates a fresh task_run
 *      and the original blocked row is closed out as cancelled.
 *   2. load the agent_task to recover prompt/sessionId/runSpecId
 *   3. runScheduledAgentTask with initialMessages injecting the answer, so the
 *      resumed execution sees "you asked X, the operator answered Y, continue"
 *
 * Known follow-up gaps (NOT closed here — see PR description):
 *   - **Trigger**: this resume only runs when runAgentTaskGraphSerial is invoked
 *     and claimReadyAgentTasks returns empty. The POST /runs/:id/answer route
 *     writes the answer but does NOT wake the scheduler (PG NOTIFY has no
 *     LISTEN; los has no resident scheduler tick). A separate intent must add
 *     either a LISTEN worker_answer subscriber or a resident resume tick.
 *   - **agent_task state**: the agent_task row is NOT transitioned here — it
 *     stays 'blocked'. graph completion will see blocked agent_tasks and report
 *     the graph as blocked (NOT succeeded — that misreport was fixed by adding
 *     the blocked branch in runClaimedAgentGraphTask). True graph convergence
 *     (agent_task blocked→running on resume) is a follow-up.
 *   - **dispatch_id for re-blocked resumed tasks**: resume does not create a
 *     task_attempts row, so a re-blocked resumed task writes worker_messages
 *     with dispatch_id=NULL and is not reclaimable. Fix requires resume to
 *     allocate an attempt id + createAgentTaskAttempt.
 */
export async function resumeBlockedTaskRunsWithAnswers(
  input: RunAgentTaskGraphSerialInput,
  limit: number,
): Promise<RunAgentTaskGraphSerialResult['executedTasks']> {
  const claimed = await claimBlockedTaskRunsWithAnswer({ graphId: input.graphId, limit });
  if (claimed.length === 0) return [];

  const results: RunAgentTaskGraphSerialResult['executedTasks'] = [];
  for (const item of claimed) {
    const { taskRun, answer, question, agentTaskId, dispatchId, provider, model } = item;
    // 1. close out the original blocked task_run
    await transitionExecutionState({
      entityType: 'task_run',
      entityId: taskRun.id,
      to: 'cancelled',
      sessionId: taskRun.sessionId,
      reason: 'resumed_with_answer',
    }).catch(() => undefined);

    // 2. load the agent_task for prompt + lineage
    const agentTask = agentTaskId ? await loadAgentTask(agentTaskId) : null;
    const prompt = agentTask?.prompt ?? agentTask?.title ?? taskRun.promptPreview;
    if (!prompt || !agentTask) {
      // Cannot rebuild the execution without the prompt — leave the task blocked
      // (un-consume is not possible, but operator can still recover via /runs/:id/recover).
      results.push({
        taskId: agentTaskId ?? taskRun.id,
        attemptId: dispatchId,
        status: 'failed',
      });
      continue;
    }

    // 3. re-run with the answer injected
    const resumeMessage = buildResumeMessage(question, answer);
    const result = await runScheduledAgentTask({
      prompt,
      promptPreview: agentTask.title,
      sessionId: agentTask.sessionId ?? input.sessionId,
      runSpecId: agentTask.runSpecId ?? input.runSpecId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      userId: input.userId,
      nodeId: input.nodeId,
      requestId: input.requestId,
      traceId: input.traceId,
      workspaceRoot: input.workspaceRoot,
      toolMode: input.toolMode,
      sandboxMode: input.sandboxMode,
      provider: provider ?? input.provider,
      model: model ?? input.model,
      executor: input.executor,
      mcpServers: input.mcpServers,
      allowedTools: input.allowedTools,
      identity: input.identity,
      initialMessages: [resumeMessage],
      onSessionEvent: input.onSessionEvent,
      onToolCallState: input.onToolCallState,
      onModelDelta: input.onModelDelta,
      onCheckpoint: input.onCheckpoint,
      onTaskEvent: input.onTaskEvent,
      metadata: {
        ...(input.metadata ?? {}),
        graphId: input.graphId,
        agentTaskId: agentTask.id,
        resumedFromTaskRunId: taskRun.id,
        resumedAskQuestion: question,
      },
    });

    const status: RunAgentTaskGraphSerialResult['executedTasks'][number]['status'] =
      result.status === 'completed' ? 'succeeded'
      : result.status === 'blocked' ? 'failed'
      : result.status === 'cancelled' ? 'cancelled'
      : 'failed';
    results.push({
      taskId: agentTask.id,
      taskRunId: result.taskRun.id,
      attemptId: dispatchId,
      status,
    });
  }
  return results;
}
