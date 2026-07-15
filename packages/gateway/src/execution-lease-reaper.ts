import { recoverExpiredTaskRunsWithAdvisoryLock } from '@los/agent/task-runs';
import { listAgentTaskAttempts, recoverExpiredAgentTasksWithAdvisoryLock } from '@los/agent/agent-task-graph';
import { writeDeadLetterEvent, writeDeadLetterForExpiredTasks } from '@los/agent/dead-letter';
import { appendSessionEvent } from '@los/agent/session-events';
import { transitionExecutionState } from '@los/agent/execution-store';

export async function reapExpiredExecutionLeases(reason: string): Promise<{
  taskRuns: number;
  agentTasks: number;
  exhaustedAgentTasks: number;
}> {
  const taskRunRecovery = await recoverExpiredTaskRunsWithAdvisoryLock(reason);
  if (taskRunRecovery.lockAcquired && taskRunRecovery.recovered.length > 0) {
    await writeDeadLetterForExpiredTasks(taskRunRecovery.recovered, 'lease_expired');
    for (const task of taskRunRecovery.recovered) {
      if (!task.runSpecId) continue;
      await transitionExecutionState({
        entityType: 'run_spec',
        entityId: task.runSpecId,
        to: 'blocked',
        sessionId: task.sessionId,
        reason: `task_run ${task.id} recovered as failed: ${reason}`,
      }).catch(() => undefined);
    }
  }

  const agentTaskRecovery = await recoverExpiredAgentTasksWithAdvisoryLock(reason);
  const recoveredAgentTasks = agentTaskRecovery.lockAcquired ? agentTaskRecovery.recovered : [];
  for (const task of recoveredAgentTasks) {
    const exhausted = task.status === 'failed';
    if (task.sessionId) {
      await appendSessionEvent({
        sessionId: task.sessionId,
        nodeId: task.claimedByNodeId,
        type: exhausted ? 'agent_task.failed' : 'agent_task.requeued',
        source: 'lease_reaper',
        payload: {
          graphId: task.graphId,
          agentTaskId: task.id,
          leaseVersion: task.leaseVersion,
          reason,
          exhausted,
        },
      });
    }
    if (exhausted) {
      const attempts = await listAgentTaskAttempts(task.id);
      const latest = attempts.at(-1);
      await writeDeadLetterEvent({
        taskRunId: latest?.taskRunId,
        runSpecId: task.runSpecId,
        reason: 'max_attempts',
        originalError: `agent task lease expired after ${attempts.length} attempt(s)`,
        eventPayload: {
          graphId: task.graphId,
          agentTaskId: task.id,
          leaseVersion: task.leaseVersion,
          sessionId: task.sessionId,
        },
      });
    }
  }

  return {
    taskRuns: taskRunRecovery.lockAcquired ? taskRunRecovery.recovered.length : 0,
    agentTasks: recoveredAgentTasks.length,
    exhaustedAgentTasks: recoveredAgentTasks.filter(task => task.status === 'failed').length,
  };
}
