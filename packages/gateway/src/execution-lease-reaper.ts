import { recoverExpiredTaskRunsWithAdvisoryLock } from '@los/agent/task-runs';
import { listAgentTaskAttempts, recoverExpiredAgentTasksWithAdvisoryLock } from '@los/agent/agent-task-graph';
import { writeDeadLetterEvent, writeDeadLetterForExpiredTasks } from '@los/agent/dead-letter';
import { appendSessionEvent } from '@los/agent/session-events';
import { transitionExecutionState } from '@los/agent/execution-store';
import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';

const log = getLogger('gateway');

export async function reapExpiredExecutionLeases(reason: string): Promise<{
  taskRuns: number;
  agentTasks: number;
  exhaustedAgentTasks: number;
}> {
  const taskRunRecovery = await recoverExpiredTaskRunsWithAdvisoryLock(reason);
  if (taskRunRecovery.lockAcquired && taskRunRecovery.recovered.length > 0) {
    await writeDeadLetterForExpiredTasks(taskRunRecovery.recovered, 'lease_expired');
    for (const task of taskRunRecovery.recovered) {
      if (!task.runSpecId) continue;
      await transitionExecutionState({
        entityType: 'run_spec',
        entityId: task.runSpecId,
        to: 'blocked',
        sessionId: task.sessionId,
        reason: `task_run ${task.id} recovered as failed: ${reason}`,
      }).catch(() => undefined);
    }
  }

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
