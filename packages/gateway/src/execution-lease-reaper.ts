import { recoverExpiredTaskRunsWithAdvisoryLock } from '@los/agent/task-runs';
import { listAgentTaskAttempts, recoverExpiredAgentTasksWithAdvisoryLock } from '@los/agent/agent-task-graph';
import { writeDeadLetterEvent, writeDeadLetterForExpiredTasks } from '@los/agent/dead-letter';
import { appendSessionEvent } from '@los/agent/session-events';
import { loadScheduledWorkItemRun, recordScheduledRunOutcome, transitionScheduledWorkRun } from '@los/agent';
import { transitionExecutionState } from '@los/agent/execution-store';
import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';

const log = getLogger('gateway');

/**
 * Converge scheduled runs whose task already reached a terminal failure but
 * whose run row is still running/claimed. This is a second, independent safety
 * net: the reaper may run on a different gateway instance or the task may have
 * failed before the convergence code was deployed.
 */
export async function _convergeOrphanedScheduledRuns(reason = 'orphaned_task_terminal'): Promise<number> {
  const db = getDb();
  const rows = await db.query<{
    run_id: string;
    schedule_id: string;
    task_id: string;
    status: string;
    task_status: string;
    result: Record<string, unknown> | null;
  }>(
    `SELECT DISTINCT ON (r.id)
            r.id AS run_id, r.schedule_id, t.id AS task_id,
            r.status, t.status AS task_status,
            t.metadata_json->'completionResult' AS result
       FROM scheduled_work_item_runs r
       JOIN task_runs t
         ON t.metadata_json->'scheduledWork'->>'runId' = r.id
      WHERE r.status IN ('running','claimed')
        AND t.status IN ('failed','cancelled','blocked','succeeded')
        AND NOT EXISTS (
          SELECT 1 FROM task_runs active
           WHERE active.metadata_json->'scheduledWork'->>'runId' = r.id
             AND active.status IN ('queued','running')
        )
        -- A retry is moved to 'claimed' with a lease before its new task row
        -- exists. Without this guard the sweep would converge that retry from
        -- the old failed task. Only an expired/absent lease is orphaned.
        AND (r.claim_owner IS NULL OR r.lease_expires_at IS NULL OR r.lease_expires_at < now())
      ORDER BY r.id, t.created_at DESC
      LIMIT 50`,
  );
  let converged = 0;
  for (const row of rows.rows) {
    try {
      const target = row.task_status === 'succeeded' ? 'succeeded' : 'failed';
      if (target === 'succeeded') {
        // A succeeded task must converge its scheduled run to succeeded, not
        // failed. The completion route may have failed to persist this; the
        // sweep is the independent backstop.
        await transitionScheduledWorkRun(row.run_id, 'succeeded', {
          ...(row.result ? { resultSummary: row.result } : {}),
        });
      } else {
        await transitionScheduledWorkRun(row.run_id, 'failed', {
          error: `task_run ${row.task_id} is ${row.task_status} without scheduled convergence`,
        });
      }
      // Keep schedule-level counters/circuit consistent with a normal runner
      // outcome. Result-work-item creation still belongs to the runner path;
      // this backstop does not fabricate a user-visible result.
      await recordScheduledRunOutcome({ scheduleId: row.schedule_id, status: target }).catch((error) => {
        log.warn(`Scheduled run ${row.run_id} outcome recording failed: ${String(error)}`);
      });
      converged++;
    } catch (error) {
      log.warn(`Orphan scheduled run ${row.run_id} convergence failed: ${String(error)}`);
    }
  }
  if (converged > 0) log.info(`Converged ${converged} orphaned scheduled run(s) (${reason})`);
  return converged;
}

export async function reapExpiredExecutionLeases(reason: string): Promise<{
  taskRuns: number;
  agentTasks: number;
  exhaustedAgentTasks: number;
}> {
  const taskRunRecovery = await recoverExpiredTaskRunsWithAdvisoryLock(reason);
  if (taskRunRecovery.lockAcquired && taskRunRecovery.recovered.length > 0) {
    await writeDeadLetterForExpiredTasks(taskRunRecovery.recovered, 'lease_expired');
    for (const task of taskRunRecovery.recovered) {
      const scheduledRunId = (task.metadata as { scheduledWork?: { runId?: unknown } } | undefined)
        ?.scheduledWork?.runId;
      if (typeof scheduledRunId === 'string' && scheduledRunId) {
        const scheduledRun = await loadScheduledWorkItemRun(scheduledRunId).catch(() => null);
        if (scheduledRun && (scheduledRun.status === 'running' || scheduledRun.status === 'claimed')) {
          await transitionScheduledWorkRun(scheduledRunId, 'failed', {
            error: `task_run ${task.id} lease expired: ${reason}`,
          }).catch((error) => {
            log.warn(`Scheduled run ${scheduledRunId} convergence failed: ${String(error)}`);
          });
        }
      }
      if (!task.runSpecId) continue;
      await transitionExecutionState({
        entityType: 'run_spec',
        entityId: task.runSpecId,
        to: 'blocked',
        sessionId: task.sessionId,
        reason: `task_run ${task.id} recovered as failed: ${reason}`,
      }).catch((error) => {
        // Do not swallow: the 30-minute stale-running sweep is only a
        // backstop, and a run_spec left `running` is a visible defect.
        log.warn(
          `Reaper could not block run_spec ${task.runSpecId} for task ${task.id}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }

  await _convergeOrphanedScheduledRuns(reason).catch((error) => {
    log.warn(`Orphan scheduled run sweep failed: ${String(error)}`);
  });

  const agentTaskRecovery = await recoverExpiredAgentTasksWithAdvisoryLock(reason);
  const recoveredAgentTasks = agentTaskRecovery.lockAcquired ? agentTaskRecovery.recovered : [];
  for (const task of recoveredAgentTasks) {
    const exhausted = task.status === 'failed';
    if (task.sessionId) {
      await appendSessionEvent({
        sessionId: task.sessionId,
        nodeId: task.claimedByNodeId,
        type: exhausted ? 'agent_task.failed' : 'agent_task.requeued',
        source: 'lease_reaper',
        payload: {
          graphId: task.graphId,
          agentTaskId: task.id,
          leaseVersion: task.leaseVersion,
          reason,
          exhausted,
        },
      });
    }
    if (exhausted) {
      const attempts = await listAgentTaskAttempts(task.id);
      const latest = attempts.at(-1);
      await writeDeadLetterEvent({
        taskRunId: latest?.taskRunId,
        runSpecId: task.runSpecId,
        reason: 'max_attempts',
        originalError: `agent task lease expired after ${attempts.length} attempt(s)`,
        eventPayload: {
          graphId: task.graphId,
          agentTaskId: task.id,
          leaseVersion: task.leaseVersion,
          sessionId: task.sessionId,
        },
      });
    }
  }

  return {
    taskRuns: taskRunRecovery.lockAcquired ? taskRunRecovery.recovered.length : 0,
    agentTasks: recoveredAgentTasks.length,
    exhaustedAgentTasks: recoveredAgentTasks.filter(task => task.status === 'failed').length,
  };
}

/**
 * Recover run_specs stuck in `running` with no active task and no heartbeat
 * for `maxAgeMinutes`. Task-level leases are handled by
 * `reapExpiredExecutionLeases`; this covers the run_spec-level gap (e.g. graph
 * runs whose workers finished but whose completion path died).
 *
 * Guard rails:
 * - only transitions through `transitionExecutionState` (AP1);
 * - requires `updated_at` older than maxAgeMinutes AND no queued/running task,
 *   so genuinely in-flight runs are never touched;
 * - transition failures are logged, never thrown.
 */
export async function recoverStaleRunningRunSpecs(options?: {
  maxAgeMinutes?: number;
}): Promise<{ scanned: number; recovered: number }> {
  const maxAgeMinutes = options?.maxAgeMinutes ?? 30;
  const db = getDb();
  const result = await db.query<{ id: string; session_id: string | null; updated_at: Date }>(
    `SELECT id, session_id, updated_at
       FROM run_specs r
      WHERE r.status = 'running'
        AND r.updated_at < now() - make_interval(mins => $1)
        AND NOT EXISTS (
          SELECT 1 FROM task_runs t
           WHERE t.run_spec_id = r.id AND t.status IN ('queued', 'running')
        )`,
    [maxAgeMinutes],
  );
  let recovered = 0;
  for (const row of result.rows) {
    const outcome = await transitionExecutionState({
      entityType: 'run_spec',
      entityId: row.id,
      to: 'blocked',
      sessionId: row.session_id ?? undefined,
      reason: `stale_running_sweep:no_active_task_since ${row.updated_at.toISOString()}`,
    }).catch((error) => {
      log.warn(
        `Stale-running sweep: failed to block run_spec ${row.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    });
    if (outcome) recovered++;
  }
  if (recovered > 0) {
    log.warn(
      `Stale-running sweep: blocked ${recovered}/${result.rows.length} run_spec(s) ` +
        `stuck in running (maxAge=${maxAgeMinutes}m)`,
    );
  }
  return { scanned: result.rows.length, recovered };
}
