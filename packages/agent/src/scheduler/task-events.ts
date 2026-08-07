import { appendSessionEvent } from '../session-events.js';
import { getLogger } from '@los/infra/logger';
import type { TaskRunRecord } from '../task-runs.js';
import type { ScheduledTaskEventType } from './types.js';

const log = getLogger('task-events');

export async function emitTaskEvent(
  sessionId: string,
  type: ScheduledTaskEventType,
  taskRun: TaskRunRecord,
  extraPayload: Record<string, unknown> = {},
): Promise<void> {
  const startedAt = Date.now();
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
  const durationMs = Date.now() - startedAt;
  if (durationMs > 500) {
    // Perf diagnostic: abnormally slow event writes show up here (e.g. the
    // 30-80s self_check_completed insert delays observed 2026-08-06).
    log.warn(`emitTaskEvent ${type} took ${durationMs}ms (session=${sessionId})`);
  }
}
