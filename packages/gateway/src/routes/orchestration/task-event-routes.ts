import type { FastifyInstance } from 'fastify';
import { appendSessionEvents } from '@los/agent/session-events';
import { verifyNodeCredential } from '@los/agent/node-enrollment';
import {
  verifyTaskToken,
  verifyTaskTokenWithRotation,
} from '../../task-token.js';
import type { TaskRouteDependencies } from './task-routes.js';

type EventDeps = Pick<TaskRouteDependencies, 'taskTokenSecret' | 'taskTokenSecrets' | 'ensureTaskRunStore' | 'loadTaskRun'>;

export function registerTaskEventRoute(app: FastifyInstance, deps: EventDeps): void {

  /**
   * Executor→gateway event batch. The task token proves the executor owns this
   * task run; clientEventId makes retries idempotent. This is the no-DB
   * executor's durable event path.
   */
  app.post('/tasks/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };
    const currentSecret = deps.taskTokenSecret();
    const secrets = deps.taskTokenSecrets?.() ?? (currentSecret ? [currentSecret] : []);
    if (secrets.length === 0) return reply.status(503).send({ error: 'task_token_secret_not_configured' });
    const rawToken = req.headers['x-los-task-token'];
    const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
    const verified = secrets.length === 1
      ? verifyTaskToken(token, secrets[0])
      : verifyTaskTokenWithRotation(token, secrets);
    let nodeAuthId: string | undefined;
    if (verified.ok) {
      if (verified.claims.taskRunId !== id) return reply.status(403).send({ error: 'task_token_scope_mismatch' });
    } else {
      // Replay after a process restart has no task token; a node credential may
      // still submit events, but only for a task run owned by that node.
      const rawCredential = req.headers['x-los-node-credential'];
      const credential = Array.isArray(rawCredential) ? rawCredential[0] : rawCredential;
      const enrollment = credential ? await verifyNodeCredential(credential) : null;
      if (!enrollment) return reply.status(401).send({ error: 'invalid_task_token', reason: verified.reason });
      nodeAuthId = enrollment.nodeId;
    }

    const body = req.body as { events?: unknown } | undefined;
    if (!Array.isArray(body?.events) || body.events.length === 0 || body.events.length > 100) {
      return reply.status(422).send({ error: 'events must be an array with 1..100 items' });
    }
    await deps.ensureTaskRunStore();
    const taskRun = await deps.loadTaskRun(id);
    if (!taskRun) return reply.status(404).send({ error: 'Not found' });
    if (nodeAuthId && taskRun.nodeId !== nodeAuthId) {
      return reply.status(403).send({ error: 'node_does_not_own_task_run', taskRunId: id });
    }

    const writes = body.events.map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`events[${index}] must be an object`);
      const event = raw as Record<string, unknown>;
      if (typeof event.type !== 'string' || !event.type) throw new Error(`events[${index}].type is required`);
      return {
        ...event,
        sessionId: taskRun.sessionId,
        nodeId: taskRun.nodeId ?? undefined,
        traceId: taskRun.traceId,
        clientEventId: typeof event.clientEventId === 'string' && event.clientEventId
          ? event.clientEventId
          : `${id}:${index}:${Date.now()}`,
      } as Parameters<typeof appendSessionEvents>[0][number];
    });
    const written = await appendSessionEvents(writes);
    return { ok: true, accepted: written.length, eventIds: written.map(event => event.id) };
  });
}
