import { heartbeatTaskRun } from '../task-runs.js';
import { heartbeatAgentTask } from '../agent-task-graph.js';
import { cancelScheduledTask } from './abort-registry.js';
import { pollCancellation } from '../cancellation.js';
import { sendHeartbeat } from '../worker-messages.js';

export function startTaskHeartbeat(
  taskRunId: string,
  nodeId: string,
  leaseVersion: number,
  leaseMs: number,
  heartbeatMs: number,
  opts?: {
    dispatchId?: string;
    taskId?: string;
    agentTaskLease?: { taskId: string; leaseVersion: number };
  },
): () => void {
  let stopped = false;
  let renewing = false;
  let leaseLost = false;

  const renewLeases = async () => {
    if (stopped || renewing || leaseLost) return;
    renewing = true;
    try {
      const [taskRun, agentTask] = await Promise.all([
        heartbeatTaskRun(taskRunId, { nodeId, leaseVersion, leaseMs }),
        opts?.agentTaskLease
          ? heartbeatAgentTask(opts.agentTaskLease.taskId, {
              nodeId,
              leaseVersion: opts.agentTaskLease.leaseVersion,
              leaseMs,
            })
          : Promise.resolve(true),
      ]);
      if (!taskRun || !agentTask) {
        leaseLost = true;
        cancelScheduledTask(taskRunId, 'lease_lost');
      }
    } catch {
      leaseLost = true;
      cancelScheduledTask(taskRunId, 'lease_heartbeat_failed');
    } finally {
      renewing = false;
    }
  };

  const interval = setInterval(() => {
    void renewLeases();
    // Poll for cross-process cancellation requests
    pollCancellation(taskRunId)
      .then((req) => {
        if (req) {
          cancelScheduledTask(taskRunId, req.reason || `cancellation requested by ${req.requestedBy}`);
        }
      })
      .catch(() => undefined);
    // Send heartbeat to worker_messages if dispatch is configured
    if (opts?.dispatchId) {
      sendHeartbeat({
        dispatchId: opts.dispatchId,
        taskId: opts.taskId,
        metadata: { nodeId },
      }).catch(() => undefined);
    }
  }, heartbeatMs);
  (interval as { unref?: () => void }).unref?.();
  void renewLeases();
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
