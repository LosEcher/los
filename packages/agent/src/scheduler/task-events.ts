import { appendSessionEvent } from '../session-events.js';
import type { TaskRunRecord } from '../task-runs.js';
import type { ScheduledTaskEventType } from './types.js';

export async function emitTaskEvent(
  sessionId: string,
  type: ScheduledTaskEventType,
  taskRun: TaskRunRecord,
  extraPayload: Record<string, unknown> = {},
): Promise<void> {
  await appendSessionEvent({
    sessionId,
    tenantId: taskRun.tenantId,
    projectId: taskRun.projectId,
    userId: taskRun.userId,
    nodeId: taskRun.nodeId,
    requestId: taskRun.requestId,
    traceId: taskRun.traceId,
    type,
    payload: {
      taskRunId: taskRun.id,
      traceId: taskRun.traceId,
      dedupeKey: taskRun.dedupeKey ?? null,
      workspaceRoot: taskRun.workspaceRoot,
      toolMode: taskRun.toolMode,
      provider: taskRun.provider ?? null,
      nodeId: taskRun.nodeId ?? null,
      requestId: taskRun.requestId ?? null,
      tenantId: taskRun.tenantId ?? null,
      projectId: taskRun.projectId ?? null,
      userId: taskRun.userId ?? null,
      heartbeatAt: taskRun.heartbeatAt ?? null,
      leaseExpiresAt: taskRun.leaseExpiresAt ?? null,
      status: taskRun.status,
      ...extraPayload,
    },
  });
}
