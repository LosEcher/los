import { getDb } from '@los/infra/db';
import { _LeaseLostError, transitionExecutionState } from '../execution-store.js';
import type { TaskRunRecord } from '../task-runs.js';
import { rowToTaskRun, type TaskRunRow } from './rows.js';
import { normalizeJsonObject } from './normalizers.js';

/**
 * Fence and fail active task attempts owned by a gateway that has gone stale.
 * The old owner must still present its node id and lease version, so a late
 * completion from that process cannot win after takeover.
 */
export async function recoverActiveTaskRunsForGateway(input: {
  gatewayId: string;
  runSpecId?: string;
  reason?: string;
}): Promise<TaskRunRecord[]> {
  const db = getDb();
  const rows = await db.query<TaskRunRow>(
    `SELECT * FROM task_runs
     WHERE node_id = $1
       AND status IN ('queued', 'running')
       AND ($2::text IS NULL OR run_spec_id = $2)
     ORDER BY updated_at ASC`,
    [input.gatewayId, input.runSpecId ?? null],
  );
  const recovered: TaskRunRecord[] = [];
  const reason = input.reason ?? 'gateway_failover_takeover';

  for (const row of rows.rows) {
    const task = rowToTaskRun(row);
    try {
      await transitionExecutionState({
        entityType: 'task_run',
        entityId: task.id,
        to: 'failed',
        sessionId: task.sessionId,
        reason,
        nodeId: input.gatewayId,
        leaseVersion: task.leaseVersion,
        leaseCondition: 'active',
        source: 'gateway.failover',
      });
    } catch (error) {
      if (error instanceof _LeaseLostError) continue;
      throw error;
    }

    const updated = await db.query<TaskRunRow>(
      `UPDATE task_runs
       SET metadata_json = $2::jsonb,
           lease_expires_at = NULL,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [task.id, JSON.stringify({
        ...normalizeJsonObject(task.metadata),
        recoveryReason: reason,
        recoveredFromGateway: input.gatewayId,
      })],
    );
    if (updated.rows[0]) recovered.push(rowToTaskRun(updated.rows[0]));
  }

  return recovered;
}
