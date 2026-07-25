import type { FastifyInstance } from 'fastify';
import { ensureTaskRunStore, loadTaskRun, listTaskRuns, listTaskRunsByStatus, updateTaskRunFields } from '@los/agent/task-runs';
import { transitionExecutionState } from '@los/agent/execution-store';
import { appendSessionEvent } from '@los/agent/session-events';
import { cancelScheduledTask } from '@los/agent/scheduler';
import { requestCancellation } from '@los/agent';
import { normalizeOptionalString } from '../server-helpers.js';
import { listServiceInstances } from '@los/agent/service-instances';
import { listDeadLetterEvents, acknowledgeDeadLetterEvent, summarizeDeadLetterEvents, requeueDeadLetterEvent } from '@los/agent';
import { getOperatorPrincipal, requireOperator } from '../../request-context.js';

export type TaskRouteDependencies = {
  acknowledgeDeadLetterEvent: typeof acknowledgeDeadLetterEvent;
  appendSessionEvent: typeof appendSessionEvent;
  cancelScheduledTask: typeof cancelScheduledTask;
  listDeadLetterEvents: typeof listDeadLetterEvents;
  listServiceInstances: typeof listServiceInstances;
  listTaskRuns: typeof listTaskRuns;
  listTaskRunsByStatus: typeof listTaskRunsByStatus;
  loadTaskRun: typeof loadTaskRun;
  requestCancellation: typeof requestCancellation;
  requeueDeadLetterEvent: typeof requeueDeadLetterEvent;
  summarizeDeadLetterEvents: typeof summarizeDeadLetterEvents;
  transitionExecutionState: typeof transitionExecutionState;
  updateTaskRunFields: typeof updateTaskRunFields;
  ensureTaskRunStore: typeof ensureTaskRunStore;
};

const defaultDependencies: TaskRouteDependencies = {
  acknowledgeDeadLetterEvent,
  appendSessionEvent,
  cancelScheduledTask,
  listDeadLetterEvents,
  listServiceInstances,
  listTaskRuns,
  listTaskRunsByStatus,
  loadTaskRun,
  requestCancellation,
  requeueDeadLetterEvent,
  summarizeDeadLetterEvents,
  transitionExecutionState,
  updateTaskRunFields,
  ensureTaskRunStore,
};

type OrphanClassification = 'stale-gateway' | 'expired-lease' | 'cancelled' | 'none';

async function classifyOrphans(deps: TaskRouteDependencies): Promise<{
  orphans: Array<{ taskRunId: string; sessionId: string; status: string; classification: OrphanClassification; gatewayId?: string }>;
  staleGatewayIds: string[];
}> {
  await deps.ensureTaskRunStore();
  const tasks = await deps.listTaskRuns(500);
  const services = await deps.listServiceInstances(200);

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

export function registerTaskRoutes(
  app: FastifyInstance,
  deps: TaskRouteDependencies = defaultDependencies,
): void {
  app.get('/tasks', async () => {
    await deps.ensureTaskRunStore();
    return await deps.listTaskRuns();
  });

  app.get('/tasks/orphans', async () => {
    return await classifyOrphans(deps);
  });

  app.get('/tasks/failed', async (_req, reply) => {
    await deps.ensureTaskRunStore();
    const tasks = await deps.listTaskRunsByStatus('failed', 50);
    return reply.send({ tasks });
  });

  app.get('/tasks/:id', async (req) => {
    const { id } = req.params as { id: string };
    await deps.ensureTaskRunStore();
    const taskRun = await deps.loadTaskRun(id);
    if (!taskRun) return { error: 'Not found' };
    return taskRun;
  });

  app.post('/tasks/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { reason?: string } | undefined;
    const reason = normalizeOptionalString(body?.reason) ?? 'cancelled_by_request';

    await deps.ensureTaskRunStore();
    const taskRun = await deps.loadTaskRun(id);
    if (!taskRun) {
      return reply.status(404).send({ error: 'Not found' });
    }

    const live = deps.cancelScheduledTask(id, reason);
    // Also write to cross-process cancellation table for remote executors
    await deps.requestCancellation(id, reason, 'api').catch(() => undefined);

    if (live) {
      await deps.transitionExecutionState({
        entityType: 'task_run',
        entityId: id,
        to: 'cancelled',
        sessionId: taskRun.sessionId,
        reason,
      }).catch(() => undefined);
      await deps.updateTaskRunFields(id, {
        metadata: {
          ...taskRun.metadata,
          cancelReason: reason,
        },
      }).catch(() => undefined);
      return { ok: true, live: true, taskRunId: id, status: 'cancelled', reason };
    }

    if (taskRun.status === 'queued' || taskRun.status === 'running') {
      await deps.transitionExecutionState({
        entityType: 'task_run',
        entityId: id,
        to: 'cancelled',
        sessionId: taskRun.sessionId,
        reason,
      });
      const cancelled = await deps.updateTaskRunFields(id, {
        metadata: {
          ...taskRun.metadata,
          cancelReason: reason,
        },
      });
      const finalTask = cancelled ?? taskRun;
      await deps.appendSessionEvent({
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
    return await deps.listDeadLetterEvents({ acknowledged, reason: reason as any, limit });
  });

  app.get('/tasks/dead-letter/summary', async () => {
    return await deps.summarizeDeadLetterEvents();
  });

  app.post('/tasks/dead-letter/:id/ack', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const { id } = req.params as { id: string };
    const body = req.body as {
      resolution?: string;
      note?: string;
      replacementTaskRunId?: string;
    } | undefined;
    const resolution = normalizeDeadLetterResolution(body?.resolution);
    if (!resolution) return reply.status(400).send({ error: 'invalid_dead_letter_resolution' });
    let record;
    try {
      record = await deps.acknowledgeDeadLetterEvent(id, {
        resolution,
        note: normalizeOptionalString(body?.note),
        replacementTaskRunId: normalizeOptionalString(body?.replacementTaskRunId),
        actor: getOperatorPrincipal(req).subject,
      });
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    if (!record) return reply.status(404).send({ error: 'Dead letter event not found or already acknowledged' });
    return record;
  });

  app.post('/tasks/dead-letter/:id/retry', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const { id } = req.params as { id: string };
    const result = await deps.requeueDeadLetterEvent(id);
    if (result.status === 'not_found') return reply.status(404).send({ error: result.reason });
    if (result.status !== 'requeued') return reply.status(409).send({ error: result.reason, event: result.event });
    return result;
  });
}

function normalizeDeadLetterResolution(
  value: unknown,
): 'replaced' | 'superseded' | 'accepted_loss' | 'regression_covered' | undefined {
  if (value === 'replaced' || value === 'superseded' || value === 'accepted_loss' || value === 'regression_covered') {
    return value;
  }
  return undefined;
}
