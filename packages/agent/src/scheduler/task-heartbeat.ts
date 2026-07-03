import { heartbeatTaskRun } from '../task-runs.js';
import { cancelScheduledTask } from './abort-registry.js';
import { pollCancellation } from '../cancellation.js';
import { sendHeartbeat } from '../worker-messages.js';

export function startTaskHeartbeat(
  taskRunId: string,
  nodeId: string,
  leaseMs: number,
  heartbeatMs: number,
  opts?: { dispatchId?: string; taskId?: string },
): () => void {
  const interval = setInterval(() => {
    heartbeatTaskRun(taskRunId, { nodeId, leaseMs }).catch(() => undefined);
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
  void heartbeatTaskRun(taskRunId, { nodeId, leaseMs }).catch(() => undefined);
  return () => clearInterval(interval);
}
