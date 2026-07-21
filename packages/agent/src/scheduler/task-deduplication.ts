import type { TaskRunRecord } from '../task-runs.js';
import { emitTaskEvent } from './task-events.js';
import type { ScheduledAgentTaskInput, ScheduledAgentTaskResult } from './types.js';

export async function reportTaskDeduplicated(
  input: ScheduledAgentTaskInput,
  taskRun: TaskRunRecord,
  duplicateTaskRunId: string,
): Promise<ScheduledAgentTaskResult> {
  await emitTaskEvent(taskRun.sessionId, 'task.deduplicated', taskRun, { duplicateTaskRunId });
  await input.onTaskEvent?.({ type: 'task.deduplicated', taskRun });
  return { status: 'deduplicated', sessionId: taskRun.sessionId, taskRun };
}
