import type { FastifyInstance } from 'fastify';
import { getConfig } from '@los/infra/config';
import { ensureTaskRunStore, heartbeatTaskRun, loadTaskRun, listTaskRuns, listTaskRunsByStatus, updateTaskRunFields } from '@los/agent/task-runs';
import { transitionExecutionState } from '@los/agent/execution-store';
import { appendSessionEvent } from '@los/agent/session-events';
import { cancelScheduledTask } from '@los/agent/scheduler';
import { requestCancellation } from '@los/agent';
import { heartbeatAgentTask } from '@los/agent/agent-task-graph';
import { listAgentTaskAttempts } from '@los/agent/agent-task-graph';
import { normalizeOptionalString, parseBoundedIntegerParam } from '../server-helpers.js';
import { listServiceInstances } from '@los/agent/service-instances';
import { listDeadLetterEvents, acknowledgeDeadLetterEvent, summarizeDeadLetterEvents, requeueDeadLetterEvent } from '@los/agent';
import { getOperatorPrincipal, requireOperator, resolveReadScope } from '../../request-context.js';
import {
  mintTaskToken,
  taskTokenExpiresAtIso,
  verifyTaskToken,
  verifyTaskTokenWithRotation,
} from '../../task-token.js';

export type TaskRouteDependencies = {
  acknowledgeDeadLetterEvent: typeof acknowledgeDeadLetterEvent;
  appendSessionEvent: typeof appendSessionEvent;
  cancelScheduledTask: typeof cancelScheduledTask;
  heartbeatTaskRun: typeof heartbeatTaskRun;
  heartbeatAgentTask: typeof heartbeatAgentTask;
  listAgentTaskAttempts: typeof listAgentTaskAttempts;
  listDeadLetterEvents: typeof listDeadLetterEvents;
  listServiceInstances: typeof listServiceInstances;
  listTaskRuns: typeof listTaskRuns;
  listTaskRunsByStatus: typeof listTaskRunsByStatus;
  loadTaskRun: typeof loadTaskRun;
  requestCancellation: typeof requestCancellation;
  requeueDeadLetterEvent: typeof requeueDeadLetterEvent;
  summarizeDeadLetterEvents: typeof summarizeDeadLetterEvents;
  taskTokenSecret: () => string | undefined;
  /** Current + previous secret during a rotation window; falls back to `taskTokenSecret`. */
  taskTokenSecrets?: () => string[];
  transitionExecutionState: typeof transitionExecutionState;
  updateTaskRunFields: typeof updateTaskRunFields;
  ensureTaskRunStore: typeof ensureTaskRunStore;
};

const defaultDependencies: TaskRouteDependencies = {
  acknowledgeDeadLetterEvent,
  appendSessionEvent,
  cancelScheduledTask,
  heartbeatTaskRun,
  heartbeatAgentTask,
  listAgentTaskAttempts,
  listDeadLetterEvents,
  listServiceInstances,
  listTaskRuns,
  listTaskRunsByStatus,
  loadTaskRun,
  requestCancellation,
  requeueDeadLetterEvent,
  summarizeDeadLetterEvents,
  taskTokenSecret: () => getConfig().executor.taskTokenSecret,
  taskTokenSecrets: () => {
    const executor = getConfig().executor;
    return [executor.taskTokenSecret, executor.taskTokenSecretPrevious]
      .filter((secret): secret is string => Boolean(secret));
  },
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
  app.get('/tasks', async (req, reply) => {
    const query = req.query as { status?: string; projectId?: string; limit?: string };
    // limit 可选；缺省仍是 50（保持既有调用方行为），但不再固定死（同 `/nodes`）。
    const limit = parseBoundedIntegerParam(query.limit, 'limit', 1, 500);
    if (!limit.ok) {
      reply.code(400);
      return { error: limit.message };
    }
    await deps.ensureTaskRunStore();
    const scope = resolveReadScope(req);
    return await deps.listTaskRuns(limit.value ?? 50, {
      ...(scope ? { tenantId: scope } : {}),
      status: normalizeOptionalString(query.status),
      projectId: normalizeOptionalString(query.projectId),
    });
  });

  app.get('/tasks/orphans', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
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
    // Read scope: a non-operator principal must not reach another tenant's run by
    // guessing its id. Same "Not found" shape as a missing row so the response
    // cannot be used to probe for existence.
    const scope = resolveReadScope(req);
    if (scope && taskRun.tenantId !== scope) return { error: 'Not found' };
    return taskRun;
  });

  /**
   * C.2 第一步：为一个**在跑/排队**的 task run 签发短时令牌。
   *
   * 为什么是 operator 门禁：现在拿到令牌就能续租约，等价于"以该 task 的身份说话"。
   * executor 侧还没有接线（下一步），所以不提前给共享 agent key 开口子——那会把
   * per-task 边界直接抹掉。
   */
  app.post('/tasks/:id/token', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const { id } = req.params as { id: string };
    const secret = deps.taskTokenSecret();
    if (!secret) {
      return reply.status(503).send({ error: 'task_token_secret_not_configured' });
    }
    await deps.ensureTaskRunStore();
    const taskRun = await deps.loadTaskRun(id);
    if (!taskRun) return reply.status(404).send({ error: 'Not found' });
    if (taskRun.status !== 'queued' && taskRun.status !== 'running') {
      return reply.status(409).send({ error: 'task_not_active', status: taskRun.status });
    }

    const body = req.body as { ttlSeconds?: unknown } | undefined;
    const ttl = normalizeTaskTokenTtl(body?.ttlSeconds);
    if (ttl === 'invalid') {
      return reply.status(400).send({
        error: 'ttlSeconds must be an integer between 60 and 3600',
      });
    }

    const minted = mintTaskToken({
      taskRunId: taskRun.id,
      leaseVersion: taskRun.leaseVersion,
      secret,
      ...(ttl === undefined ? {} : { ttlSeconds: ttl }),
    });
    return {
      ok: true,
      token: minted.token,
      taskRunId: minted.claims.taskRunId,
      leaseVersion: minted.claims.leaseVersion,
      expiresAt: taskTokenExpiresAtIso(minted.claims.expiresAt),
    };
  });

  /**
   * 令牌验证的唯一落点（第一步只接这一个端点）。
   *
   * 三条刻意的选择：
   *   · **只认 `x-los-task-token`**，不看 operator/agent key —— 否则"过期令牌 ⇒ 401"
   *     会被共享密钥回退掩盖（C1）；
   *   · 令牌里的 `taskRunId` 必须等于路径 id，否则 403 —— 拿 A 的令牌续 B 的租约（C2）；
   *   · 续租的 nodeId 取自**库里的任务行**而不是请求体 —— 请求体可伪造，而令牌已绑定任务。
   */
  app.post('/tasks/:id/heartbeat', async (req, reply) => {
    const { id } = req.params as { id: string };
    const currentSecret = deps.taskTokenSecret();
    const secrets = deps.taskTokenSecrets?.() ?? (currentSecret ? [currentSecret] : []);
    if (secrets.length === 0) {
      return reply.status(503).send({ error: 'task_token_secret_not_configured' });
    }
    const rawToken = req.headers['x-los-task-token'];
    const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
    const verified = secrets.length === 1
      ? verifyTaskToken(token, secrets[0])
      : verifyTaskTokenWithRotation(token, secrets);
    if (!verified.ok) {
      return reply.status(401).send({ error: 'invalid_task_token', reason: verified.reason });
    }
    if (verified.claims.taskRunId !== id) {
      return reply.status(403).send({ error: 'task_token_scope_mismatch' });
    }

    await deps.ensureTaskRunStore();
    const taskRun = await deps.loadTaskRun(id);
    if (!taskRun) return reply.status(404).send({ error: 'Not found' });
    if (!taskRun.nodeId) {
      return reply.status(409).send({ error: 'task_has_no_node', taskRunId: taskRun.id });
    }

    const body = req.body as { leaseMs?: unknown } | undefined;
    const leaseMs = normalizeLeaseMsRequest(body?.leaseMs);
    if (leaseMs === 'invalid') {
      return reply.status(400).send({ error: 'leaseMs must be an integer between 1000 and 600000' });
    }

    const renewed = await deps.heartbeatTaskRun(id, {
      nodeId: taskRun.nodeId,
      leaseVersion: verified.claims.leaseVersion,
      ...(leaseMs === undefined ? {} : { leaseMs }),
    });
    if (!renewed) {
      // 典型原因：lease_version 已换代、任务已终态、或租约先过期。
      // 不在这里重试、不刷新令牌——换代后旧令牌就是应当失效。
      return reply.status(409).send({ error: 'lease_lost_or_expired', taskRunId: id });
    }
    // Long tasks outlive the 1h token cap. Rotate the token from the same
    // authenticated heartbeat when it enters the refresh window; the old token
    // remains valid until its own exp, so a lost response is recoverable.
    const refreshWindowSeconds = 15 * 60;
    const remainingSeconds = verified.claims.expiresAt - Math.floor(Date.now() / 1000);
    const refreshed = currentSecret && remainingSeconds <= refreshWindowSeconds
      ? mintTaskToken({
          taskRunId: id,
          leaseVersion: renewed.leaseVersion,
          secret: currentSecret,
        })
      : undefined;

    return {
      ok: true,
      taskRunId: renewed.id,
      leaseVersion: renewed.leaseVersion,
      heartbeatAt: renewed.heartbeatAt ?? null,
      leaseExpiresAt: renewed.leaseExpiresAt ?? null,
      ...(refreshed
        ? {
            taskToken: refreshed.token,
            taskTokenExpiresAt: taskTokenExpiresAtIso(refreshed.claims.expiresAt),
          }
        : {}),
    };
  });

  /**
   * Agent-task lease renewal over HTTP. It stays on the short-lived task token
   * (path taskRunId must match the token), then checks that the agent task has
   * a running attempt for that task run. nodeId and leaseVersion are never
   * trusted from the body for placement.
   */
  app.post('/tasks/:id/agent-tasks/:agentTaskId/heartbeat', async (req, reply) => {
    const { id, agentTaskId } = req.params as { id: string; agentTaskId: string };
    const currentSecret = deps.taskTokenSecret();
    const secrets = deps.taskTokenSecrets?.() ?? (currentSecret ? [currentSecret] : []);
    if (secrets.length === 0) {
      return reply.status(503).send({ error: 'task_token_secret_not_configured' });
    }
    const rawToken = req.headers['x-los-task-token'];
    const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
    const verified = secrets.length === 1
      ? verifyTaskToken(token, secrets[0])
      : verifyTaskTokenWithRotation(token, secrets);
    if (!verified.ok) return reply.status(401).send({ error: 'invalid_task_token', reason: verified.reason });
    if (verified.claims.taskRunId !== id) return reply.status(403).send({ error: 'task_token_scope_mismatch' });

    const body = req.body as { leaseVersion?: unknown; leaseMs?: unknown } | undefined;
    if (typeof body?.leaseVersion !== 'number' || !Number.isSafeInteger(body.leaseVersion) || body.leaseVersion < 1) {
      return reply.status(400).send({ error: 'leaseVersion must be a positive integer' });
    }
    const leaseMs = normalizeLeaseMsRequest(body?.leaseMs);
    if (leaseMs === 'invalid') {
      return reply.status(400).send({ error: 'leaseMs must be an integer between 1000 and 600000' });
    }

    await deps.ensureTaskRunStore();
    const taskRun = await deps.loadTaskRun(id);
    if (!taskRun) return reply.status(404).send({ error: 'Not found' });
    if (!taskRun.nodeId) return reply.status(409).send({ error: 'task_has_no_node', taskRunId: taskRun.id });

    const attempts = await deps.listAgentTaskAttempts(agentTaskId);
    const bound = attempts.some(attempt => attempt.taskRunId === id && attempt.status === 'running');
    if (!bound) return reply.status(403).send({ error: 'agent_task_not_bound_to_task_run', agentTaskId, taskRunId: id });

    const renewed = await deps.heartbeatAgentTask(agentTaskId, {
      nodeId: taskRun.nodeId,
      leaseVersion: body.leaseVersion,
      ...(leaseMs === undefined ? {} : { leaseMs }),
    });
    if (!renewed) {
      return reply.status(409).send({ error: 'agent_task_lease_lost', agentTaskId, taskRunId: id });
    }
    return {
      ok: true,
      agentTaskId: renewed.id,
      leaseVersion: renewed.leaseVersion,
      leaseExpiresAt: renewed.leaseExpiresAt ?? null,
    };
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

  app.get('/tasks/dead-letter', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const query = req.query as { acknowledged?: string; reason?: string; limit?: string };
    const acknowledged = query.acknowledged === 'true' ? true : query.acknowledged === 'false' ? false : undefined;
    const reason = normalizeOptionalString(query.reason);
    const limit = query.limit ? parseInt(query.limit, 10) || 50 : 50;
    return await deps.listDeadLetterEvents({ acknowledged, reason: reason as any, limit });
  });

  app.get('/tasks/dead-letter/summary', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
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

function normalizeTaskTokenTtl(value: unknown): number | undefined | 'invalid' {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) return 'invalid';
  if (value < 60 || value > 3_600) return 'invalid';
  return value;
}

function normalizeLeaseMsRequest(value: unknown): number | undefined | 'invalid' {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) return 'invalid';
  if (value < 1_000 || value > 600_000) return 'invalid';
  return value;
}

function normalizeDeadLetterResolution(
  value: unknown,
): 'replaced' | 'superseded' | 'accepted_loss' | 'regression_covered' | undefined {
  if (value === 'replaced' || value === 'superseded' || value === 'accepted_loss' || value === 'regression_covered') {
    return value;
  }
  return undefined;
}
