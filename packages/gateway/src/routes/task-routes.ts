import type { FastifyInstance } from 'fastify';
import { ensureTaskRunStore, loadTaskRun, listTaskRuns, updateTaskRun } from '@los/agent/task-runs';
import { appendSessionEvent } from '@los/agent/session-events';
import { cancelScheduledTask } from '@los/agent/scheduler';
import { normalizeOptionalString } from './server-helpers.js';

export function registerTaskRoutes(app: FastifyInstance): void {
  app.get('/tasks', async () => {
    await ensureTaskRunStore();
    return await listTaskRuns();
  });

  app.get('/tasks/:id', async (req) => {
    const { id } = req.params as { id: string };
    await ensureTaskRunStore();
    const taskRun = await loadTaskRun(id);
    if (!taskRun) return { error: 'Not found' };
    return taskRun;
  });

  app.post('/tasks/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { reason?: string } | undefined;
    const reason = normalizeOptionalString(body?.reason) ?? 'cancelled_by_request';

    await ensureTaskRunStore();
    const taskRun = await loadTaskRun(id);
    if (!taskRun) {
      return reply.status(404).send({ error: 'Not found' });
    }

    const live = cancelScheduledTask(id, reason);
    if (live) {
      await updateTaskRun(id, {
        status: 'cancelled',
        metadata: {
          ...taskRun.metadata,
          cancelReason: reason,
        },
      }).catch(() => undefined);
      return { ok: true, live: true, taskRunId: id, status: 'cancelled', reason };
    }

    if (taskRun.status === 'queued' || taskRun.status === 'running') {
      const cancelled = await updateTaskRun(id, {
        status: 'cancelled',
        metadata: {
          ...taskRun.metadata,
          cancelReason: reason,
        },
      });
      const finalTask = cancelled ?? taskRun;
      await appendSessionEvent({
        sessionId: finalTask.sessionId,
        tenantId: finalTask.tenantId,
        projectId: finalTask.projectId,
        userId: finalTask.userId,
        nodeId: finalTask.nodeId,
        requestId: finalTask.requestId,
        traceId: finalTask.traceId,
        type: 'task.cancelled',
        payload: {
          taskRunId: finalTask.id,
          traceId: finalTask.traceId,
          dedupeKey: finalTask.dedupeKey ?? null,
          reason,
          live: false,
        },
      }).catch(() => undefined);
      return { ok: true, live: false, taskRun: finalTask };
    }

    return {
      ok: false,
      live: false,
      taskRun,
      reason: `Task is already ${taskRun.status}`,
    };
  });
}
