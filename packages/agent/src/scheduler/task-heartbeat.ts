import { heartbeatTaskRun } from '../task-runs.js';
import { cancelScheduledTask } from './abort-registry.js';
import { pollCancellation } from '../cancellation.js';

export function startTaskHeartbeat(
  taskRunId: string,
  nodeId: string,
  leaseMs: number,
  heartbeatMs: number,
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
  }, heartbeatMs);
  void heartbeatTaskRun(taskRunId, { nodeId, leaseMs }).catch(() => undefined);
  return () => clearInterval(interval);
}
