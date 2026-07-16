import type { FastifyInstance } from 'fastify';
import { ensureTaskRunStore, loadTaskRun, listTaskRuns, listTaskRunsByStatus, updateTaskRunFields } from '@los/agent/task-runs';
import { transitionExecutionState } from '@los/agent/execution-store';
import { appendSessionEvent } from '@los/agent/session-events';
import { cancelScheduledTask } from '@los/agent/scheduler';
import { requestCancellation } from '@los/agent';
import { normalizeOptionalString } from '../server-helpers.js';
import { listServiceInstances } from '@los/agent/service-instances';
import { listDeadLetterEvents, acknowledgeDeadLetterEvent, summarizeDeadLetterEvents, requeueDeadLetterEvent } from '@los/agent';
import { requireOperator } from '../../request-context.js';

type OrphanClassification = 'stale-gateway' | 'expired-lease' | 'cancelled' | 'none';

async function classifyOrphans(): Promise<{
  orphans: Array<{ taskRunId: string; sessionId: string; status: string; classification: OrphanClassification; gatewayId?: string }>;
  staleGatewayIds: string[];
}> {
  await ensureTaskRunStore();
  const tasks = await listTaskRuns(500);
  const services = await listServiceInstances(200);

  const now = Date.now();
  const staleMs = 60_000;
  const staleGatewayIds = services
    .filter(s => s.serviceKind === 'gateway' && s.status === 'online' &&
      s.lastHeartbeatAt && (now - new Date(s.lastHeartbeatAt).getTime()) > staleMs)
    .map(s => s.serviceId);

  const orphans = tasks
    .filter(t => t.status === 'running' || t.status === 'queued')
    .map(t => {
      let classification: OrphanClassification = 'none';
      if (t.leaseExpiresAt && new Date(t.leaseExpiresAt).getTime() < now) {
        classification = 'expired-lease';
      } else if (t.nodeId && staleGatewayIds.includes(t.nodeId)) {
        classification = 'stale-gateway';
      }
      return {
        taskRunId: t.id,
        sessionId: t.sessionId,
        status: t.status,
        classification,
        gatewayId: t.nodeId,
      };
    })
    .filter(t => t.classification !== 'none');

  return { orphans, staleGatewayIds };
}

export function registerTaskRoutes(app: FastifyInstance): void {
  app.get('/tasks', async () => {
    await ensureTaskRunStore();
    return await listTaskRuns();
  });

  app.get('/tasks/orphans', async () => {
    return await classifyOrphans();
  });

  app.get('/tasks/failed', async (_req, reply) => {
    await ensureTaskRunStore();
    const tasks = await listTaskRunsByStatus('failed', 50);
    return reply.send({ tasks });
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
    // Also write to cross-process cancellation table for remote executors
    await requestCancellation(id, reason, 'api').catch(() => undefined);

    if (live) {
      await transitionExecutionState({
        entityType: 'task_run',
        entityId: id,
        to: 'cancelled',
        sessionId: taskRun.sessionId,
        reason,
      }).catch(() => undefined);
      await updateTaskRunFields(id, {
        metadata: {
          ...taskRun.metadata,
          cancelReason: reason,
        },
      }).catch(() => undefined);
      return { ok: true, live: true, taskRunId: id, status: 'cancelled', reason };
    }

    if (taskRun.status === 'queued' || taskRun.status === 'running') {
      await transitionExecutionState({
        entityType: 'task_run',
        entityId: id,
        to: 'cancelled',
        sessionId: taskRun.sessionId,
        reason,
      });
      const cancelled = await updateTaskRunFields(id, {
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

  // ── Dead Letter Queue ─────────────────────────────────

  app.get('/tasks/dead-letter', async (req) => {
    const query = req.query as { acknowledged?: string; reason?: string; limit?: string };
    const acknowledged = query.acknowledged === 'true' ? true : query.acknowledged === 'false' ? false : undefined;
    const reason = normalizeOptionalString(query.reason);
    const limit = query.limit ? parseInt(query.limit, 10) || 50 : 50;
    return await listDeadLetterEvents({ acknowledged, reason: reason as any, limit });
  });

  app.get('/tasks/dead-letter/summary', async () => {
    return await summarizeDeadLetterEvents();
  });

  app.post('/tasks/dead-letter/:id/ack', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = await acknowledgeDeadLetterEvent(id);
    if (!record) return reply.status(404).send({ error: 'Dead letter event not found or already acknowledged' });
    return record;
  });

  app.post('/tasks/dead-letter/:id/retry', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const { id } = req.params as { id: string };
    const result = await requeueDeadLetterEvent(id);
    if (result.status === 'not_found') return reply.status(404).send({ error: result.reason });
    if (result.status !== 'requeued') return reply.status(409).send({ error: result.reason, event: result.event });
    return result;
  });
}
