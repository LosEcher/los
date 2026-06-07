import { heartbeatTaskRun } from '../task-runs.js';

export function startTaskHeartbeat(
  taskRunId: string,
  nodeId: string,
  leaseMs: number,
  heartbeatMs: number,
): () => void {
  const interval = setInterval(() => {
    heartbeatTaskRun(taskRunId, { nodeId, leaseMs }).catch(() => undefined);
  }, heartbeatMs);
  void heartbeatTaskRun(taskRunId, { nodeId, leaseMs }).catch(() => undefined);
  return () => clearInterval(interval);
}
