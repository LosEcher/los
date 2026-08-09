import { getLogger } from '@los/infra/logger';

import { loadTaskRun, type TaskRunRecord } from '../task-runs.js';
import { scheduledWorkExecutionHeartbeatMs } from './lease.js';
import { heartbeatScheduledWorkRun } from './recovery.js';

const log = getLogger('scheduled-work');
const TASK_TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'blocked']);

export function startScheduledWorkExecutionHeartbeat(input: {
  runId: string;
  ownerId?: string | null;
  leaseMs: number;
}): () => void {
  const timer = setInterval(() => {
    void heartbeatScheduledWorkRun({
      runId: input.runId,
      ownerId: input.ownerId,
      leaseMs: input.leaseMs,
    }).catch((error) => {
      log.warn(
        `Scheduled work lease heartbeat failed for ${input.runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, scheduledWorkExecutionHeartbeatMs());
  // Do not keep the process alive solely for heartbeats.
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Poll until the dedupe-owner task leaves queued/running, or until the
 * execution lease budget is exhausted. Used when a reclaim hits the same
 * `schedule-exec-${runId}` key that is still mid-flight.
 */
export async function waitForAdoptedScheduleTask(
  task: TaskRunRecord,
  timeoutMs: number,
): Promise<TaskRunRecord> {
  const deadline = Date.now() + Math.max(5_000, timeoutMs);
  let current = task;
  while (!TASK_TERMINAL.has(current.status)) {
    if (Date.now() >= deadline) {
      throw new Error(`Scheduled execution adopt timed out waiting for task ${task.id}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const loaded = await loadTaskRun(task.id);
    if (!loaded) throw new Error(`Scheduled execution adopted task disappeared: ${task.id}`);
    current = loaded;
  }
  return current;
}
