import type { FastifyInstance } from 'fastify';
import { loadTaskRun, updateTaskRunFields } from '@los/agent/task-runs';
import { transitionExecutionState } from '@los/agent/execution-store';
import {
  attachScheduleRecoveryWorkItem,
  attachScheduledRunWorkItem,
  createScheduleResultWorkItem,
  loadScheduledWorkItemRun,
  recordScheduledRunOutcome,
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

/**
 * Converge a linked scheduled run after a task reached a terminal status.
 * Exported so the route-first path (no-DB executor posts /complete before the
 * scheduled runner resumes) can be tested without booting Fastify.
 *
 * Returns the run's status (existing terminal status, or the target), or
 * undefined when there is no linked run.
 */
export async function _convergeScheduledRunForCompletion(
  scheduledRunId: string,
  target: 'succeeded' | 'failed',
  convergenceError?: string,
  result?: Record<string, unknown>,
): Promise<string | undefined> {
  const run = await loadScheduledWorkItemRun(scheduledRunId);
  if (!run) return undefined;
  if (terminal(run.status)) return run.status;
  await transitionScheduledWorkRun(scheduledRunId, target, {
    error: convergenceError,
    resultSummary: result,
  });
  // The completion route is the terminalizing writer in the no-DB path; the
  // scheduled runner's later transition loses the race and returns without
  // recording the outcome. Record it here so schedule counters/circuit stay
  // correct.
  const outcome = await recordScheduledRunOutcome({
    scheduleId: run.scheduleId,
    status: target,
  });
  if (target === 'failed' && outcome.circuitOpened) {
    const workItemId = await createScheduleResultWorkItem(outcome.schedule, run, 'failed', {
      error: convergenceError,
      circuitState: 'open',
      consecutiveFailures: outcome.schedule.consecutiveFailures,
    }, `${outcome.schedule.title}: recovery required`);
    await attachScheduleRecoveryWorkItem(run.scheduleId, workItemId);
    await attachScheduledRunWorkItem(run.id, workItemId);
  }
  return target;
}

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
    let scheduledConvergencePending = false;
    const scheduledRunId = (taskRun.metadata as { scheduledWork?: { runId?: unknown } } | undefined)
      ?.scheduledWork?.runId;
    if (typeof scheduledRunId === 'string' && scheduledRunId) {
      try {
        const target = effectiveStatus === 'succeeded' ? 'succeeded' : 'failed';
        const convergenceError = effectiveStatus === 'succeeded'
          ? undefined
          : error ?? `task ${effectiveStatus}`;
        scheduledStatus = await _convergeScheduledRunForCompletion(
          scheduledRunId, target, convergenceError, result,
        );
      } catch (err: any) {
        // The task is already terminal; do not fail the completion request.
        // Signal that the scheduled run still needs convergence so the
        // periodic orphan sweep retries it instead of leaving a silent 200.
        scheduledWarning = err?.message ?? String(err);
        scheduledConvergencePending = true;
      }
    }
    return {
      ok: true,
      taskRunId: id,
      status: updated.status,
      ...(scheduledStatus ? { scheduledStatus } : {}),
      ...(scheduledWarning ? { scheduledWarning } : {}),
      ...(scheduledConvergencePending ? { scheduledConvergencePending: true } : {}),
    };
  });
}
