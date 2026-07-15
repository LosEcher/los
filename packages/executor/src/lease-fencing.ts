import { heartbeatAgentTask, heartbeatTaskRun, loadTaskRun } from '@los/agent';
import { createAbortError } from './executor-helpers.js';

export async function _renewTaskLease(
  taskRunId: string,
  nodeId: string,
  leaseVersion: number,
  agentTaskLease: { taskId: string; leaseVersion: number } | undefined,
  leaseMs: number,
  controller: AbortController,
): Promise<void> {
  const [renewedTaskRun, renewedAgentTask] = await Promise.all([
    heartbeatTaskRun(taskRunId, { nodeId, leaseVersion, leaseMs }),
    agentTaskLease
      ? heartbeatAgentTask(agentTaskLease.taskId, {
          nodeId,
          leaseVersion: agentTaskLease.leaseVersion,
          leaseMs,
        })
      : Promise.resolve(true),
  ]);
  const taskRun = renewedTaskRun ?? await loadTaskRun(taskRunId);
  if ((!renewedTaskRun || !renewedAgentTask) && !controller.signal.aborted) {
    controller.abort(createAbortError(
      taskRun?.status === 'cancelled' ? 'cancelled_by_scheduler' : 'lease_lost',
    ));
  }
}
