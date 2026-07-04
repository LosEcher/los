/**
 * @los/agent/scheduler/resume-tasks — resume blocked task_runs whose `ask` was answered.
 *
 * Extracted from scheduler.ts to keep that file under the 600-line CI block gate.
 */

import { transitionExecutionState } from '../execution-store.js';
import { listAgentTasksForRunSpec, loadAgentTask, updateAgentTaskStatus, type AgentTaskStatus } from '../agent-task-graph.js';
import { claimBlockedTaskRunsWithAnswer } from '../task-runs/blocked-resume.js';
import { runScheduledAgentTask } from './scheduled-task-runner.js';
import { buildResumeMessage } from './resume-messages.js';
import type {
  RunAgentTaskGraphSerialInput,
  RunAgentTaskGraphSerialResult,
  ScheduledAgentTaskResult,
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
 *     and claimReadyAgentTasks returns empty, OR when the gateway POST /runs/:id/answer
 *     fire-and-forgets resumeAnsweredAsksForRunSpec. The PG NOTIFY emitted by the
 *     answer route has no LISTEN; los has no resident scheduler tick — the direct
 *     call from the gateway is the active trigger in a single-gateway deployment.
 *     A LISTEN worker_answer subscriber is tracked for future multi-gateway mesh.
 *   - **dispatch_id for re-blocked resumed tasks**: resume does not create a
 *     task_attempts row, so a re-blocked resumed task writes worker_messages
 *     with dispatch_id=NULL and is not reclaimable. Fix requires resume to
 *     allocate an attempt id + createAgentTaskAttempt.
 *   - **Config loss on resume**: resumeAnsweredAsksForRunSpec builds a minimal
 *     {graphId, runSpecId} input; executor/sandboxMode/mcpServers/allowedTools/
 *     identity are undefined, so resume runs on the gateway-local executor with
 *     default workspace-write sandbox even if the original task ran on a remote
 *     sandbox executor. Fix requires restoring these from run_spec/task_run
 *     metadata.
 *   - **Crash window**: if the gateway restarts between claimBlockedTaskRunsWithAnswer
 *     (which sets consumed_at) and createTaskRun, the answer is marked consumed
 *     but no new task_run is created — with no LISTEN/retry tick the answer is
 *     orphaned. Idempotent resume audit (scan consumed_at set with no matching
 *     new task_run) is a follow-up.
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

    // 2. transition agent_task blocked → running so graph completion does
    //    NOT report the graph as blocked while resume is in-flight. This
    //    mirrors runClaimedAgentGraphTask which sets running before the
    //    dispatch. If this fails (rare, e.g. DB error), leave the task as-is
    //    — consumed_at is already set, so we still reach the stage 3 results.
    if (agentTaskId) {
      await updateAgentTaskStatus(agentTaskId, 'running', {
        dispatchId,
        resumedFromTaskRunId: taskRun.id,
      }).catch(() => undefined);
    }

    // 3. load the agent_task for prompt + lineage
    const agentTask = agentTaskId ? await loadAgentTask(agentTaskId) : null;
    const prompt = agentTask?.prompt ?? agentTask?.title ?? taskRun.promptPreview;
    if (!prompt || !agentTask) {
      // Cannot rebuild the execution without the prompt — transition the
      // agent_task back to blocked so the operator can see it (un-consume
      // is not possible, but operator can still recover via /runs/:id/recover).
      if (agentTaskId) {
        await updateAgentTaskStatus(agentTaskId, 'blocked', {
          error: 'resume_failed: missing prompt or agent_task',
          dispatchId,
        }).catch(() => undefined);
      }
      results.push({
        taskId: agentTaskId ?? taskRun.id,
        attemptId: dispatchId,
        status: 'failed',
      });
      continue;
    }

    // 4. re-run with the answer injected
    const resumeMessage = buildResumeMessage(question, answer);
    let result: ScheduledAgentTaskResult;
    try {
      result = await runScheduledAgentTask({
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
        workspaceRoot: taskRun.workspaceRoot ?? input.workspaceRoot,
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
    } catch (err) {
      // runScheduledAgentTask re-throws non-abort errors (line 462 of
      // scheduled-task-runner.ts). Without a catch here, the agent_task
      // would stay 'running' forever (step 2 set it, no lease, consumed_at
      // already burned — no recovery path). Roll back to blocked so the
      // operator can see it and recover via /runs/:id/recover.
      const msg = err instanceof Error ? err.message : String(err);
      await updateAgentTaskStatus(agentTask.id, 'blocked', {
        dispatchId,
        resumedFromTaskRunId: taskRun.id,
        error: msg,
      }).catch(() => undefined);
      results.push({
        taskId: agentTask.id,
        attemptId: dispatchId,
        status: 'failed',
      });
      continue;
    }

    const executedStatus: RunAgentTaskGraphSerialResult['executedTasks'][number]['status'] =
      result.status === 'completed' ? 'succeeded'
      : result.status === 'blocked' ? 'failed'
      : result.status === 'cancelled' ? 'cancelled'
      : result.status === 'deduplicated' ? 'succeeded'
      : 'failed';

    // 5. transition agent_task to match the actual outcome, so graph
    //    completion converges. This mirrors runClaimedAgentGraphTask's
    //    branch for each terminal status.
    //
    //    - succeeded: graph can proceed to the next task / converge to done.
    //    - blocked: the resumed task re-blocked (e.g. asked again); graph
    //      stays blocked awaiting the next answer.
    //    - cancelled: graph sees a clean cancellation.
    //    - failed/deduplicated: graph sees a terminal failure (deduplication
    //      during resume is unexpected — it can happen if a dedupeKey is
    //      added and a concurrent resume already ran).
    //    NOTE: returned `status` still uses AgentTaskAttemptStatus for
    //    compatibility with the caller (scheduler.ts loop); 'blocked' is NOT
    //    in AgentTaskAttemptStatus, so resume re-uses 'failed' for the
    //    executedTasks record (the scheduler loop already checks task.status
    //    !== 'succeeded' to break, and runClaimedAgentGraphTask uses 'failed'
    //    for the blocked branch — idempotent).
    const terminalStatus: AgentTaskStatus =
      result.status === 'completed' ? 'succeeded'
      : result.status === 'blocked' ? 'blocked'
      : result.status === 'cancelled' ? 'cancelled'
      : 'failed';
    await updateAgentTaskStatus(agentTask.id, terminalStatus, {
      taskRunId: result.taskRun.id ?? undefined,
      dispatchId,
      resumedFromTaskRunId: taskRun.id,
      resumedAskQuestion: question,
      ...('reason' in result && result.status === 'cancelled' ? { cancelReason: result.reason } : {}),
      ...('reason' in result && result.status === 'blocked' ? { blockReason: result.reason } : {}),
    }).catch(() => undefined);

    results.push({
      taskId: agentTask.id,
      taskRunId: 'taskRun' in result ? result.taskRun.id : undefined,
      attemptId: dispatchId,
      status: executedStatus,
    });
  }
  return results;
}

/**
 * Resume answered `ask`-blocked tasks for a run spec. Intended as the trigger
 * that closes the ask loop: the gateway POST /runs/:id/answer route writes the
 * answer, then calls this (fire-and-forget) to resume the blocked task without
 * waiting for an external runAgentTaskGraphSerial invocation.
 *
 * Looks up the graph_id from the run spec's agent_tasks, then delegates to
 * resumeBlockedTaskRunsWithAnswers with a minimal input (sessionId/workspaceRoot
 * come from each claimed task_run, not the input). Returns the count resumed.
 */
export async function resumeAnsweredAsksForRunSpec(
  runSpecId: string,
  limit = 10,
): Promise<{ resumed: number }> {
  const tasks = await listAgentTasksForRunSpec(runSpecId);
  // Pick the graph of a BLOCKED task (not tasks[0], which may be a succeeded
  // task from an older graph — resuming that graph's empty claim is a wasted
  // locked round-trip and misses the blocked task on a newer graph).
  const blockedTask = tasks.find(t => t.status === 'blocked');
  const graphId = blockedTask?.graphId;
  if (!graphId) return { resumed: 0 };
  const results = await resumeBlockedTaskRunsWithAnswers({ graphId, runSpecId } as RunAgentTaskGraphSerialInput, limit);
  return { resumed: results.length };
}
