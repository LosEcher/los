import type { FastifyInstance } from 'fastify';
import { loadTaskRun, updateTaskRunFields } from '@los/agent/task-runs';
import { transitionExecutionState } from '@los/agent/execution-store';
import {
  loadScheduledWorkItemRun,
  transitionScheduledWorkRun,
} from '@los/agent';
import {
  verifyTaskToken,
  verifyTaskTokenWithRotation,
} from '../../task-token.js';
import { getConfig } from '@los/infra/config';

type CompleteStatus = 'succeeded' | 'failed' | 'blocked';

function terminal(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'blocked';
}

/**
 * Terminal task completion from a no-DB executor. The task token binds this to
 * the task run; status is explicit instead of waiting for the gateway reaper.
 * Scheduled runs linked through `metadata.scheduledWork.runId` are converged in
 * the same request.
 */
export function registerTaskCompleteRoute(app: FastifyInstance): void {
  app.post('/tasks/:id/complete', async (req, reply) => {
    const { id } = req.params as { id: string };
    const currentSecret = getConfig().executor.taskTokenSecret;
    const previous = getConfig().executor.taskTokenSecretPrevious;
    const secrets = [currentSecret, previous].filter((secret): secret is string => Boolean(secret));
    if (secrets.length === 0) return reply.status(503).send({ error: 'task_token_secret_not_configured' });
    const rawToken = req.headers['x-los-task-token'];
    const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
    const verified = secrets.length === 1
      ? verifyTaskToken(token, secrets[0])
      : verifyTaskTokenWithRotation(token, secrets);
    if (!verified.ok) return reply.status(401).send({ error: 'invalid_task_token', reason: verified.reason });
    if (verified.claims.taskRunId !== id) return reply.status(403).send({ error: 'task_token_scope_mismatch' });

    const body = req.body as { status?: unknown; error?: unknown; result?: unknown } | undefined;
    const status = body?.status;
    if (status !== 'succeeded' && status !== 'failed' && status !== 'blocked') {
      return reply.status(422).send({ error: 'status must be succeeded|failed|blocked' });
    }
    const taskRun = await loadTaskRun(id);
    if (!taskRun) return reply.status(404).send({ error: 'Not found' });
    const alreadyTerminal = terminal(taskRun.status);
    const error = typeof body?.error === 'string' ? body.error : undefined;
    const result = body?.result && typeof body.result === 'object' && !Array.isArray(body.result)
      ? body.result as Record<string, unknown>
      : undefined;
    if (!alreadyTerminal) {
      await transitionExecutionState({
        entityType: 'task_run',
        entityId: id,
        to: status as CompleteStatus,
        sessionId: taskRun.sessionId,
        reason: error ?? `executor reported ${status}`,
      });
    }
    const updated = alreadyTerminal
      ? taskRun
      : await updateTaskRunFields(id, {
        metadata: {
          ...taskRun.metadata,
          ...(error ? { completionError: error } : {}),
          ...(result ? { completionResult: result } : {}),
        },
      });
    if (!updated) return reply.status(404).send({ error: 'Not found' });
    const effectiveStatus = updated.status;

    let scheduledStatus: string | undefined;
    let scheduledWarning: string | undefined;
    const scheduledRunId = (taskRun.metadata as { scheduledWork?: { runId?: unknown } } | undefined)
      ?.scheduledWork?.runId;
    if (typeof scheduledRunId === 'string' && scheduledRunId) {
      try {
        const run = await loadScheduledWorkItemRun(scheduledRunId);
        if (run && !terminal(run.status)) {
          const target = effectiveStatus === 'succeeded' ? 'succeeded' : 'failed';
          await transitionScheduledWorkRun(scheduledRunId, target, {
            error: effectiveStatus === 'succeeded' ? undefined : error ?? `task ${effectiveStatus}`,
            resultSummary: result,
          });
          scheduledStatus = target;
        } else if (run) {
          scheduledStatus = run.status;
        }
      } catch (err: any) {
        scheduledWarning = err?.message ?? String(err);
      }
    }
    return {
      ok: true,
      taskRunId: id,
      status: updated.status,
      ...(scheduledStatus ? { scheduledStatus } : {}),
      ...(scheduledWarning ? { scheduledWarning } : {}),
    };
  });
}
