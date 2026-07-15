import { getDb, withDbClient } from '@los/infra/db';
import { ensureAgentTaskGraphStore, type AgentTaskRecord, type AgentTaskRow, rowToTask } from '../agent-task-graph.js';
import { resolveCoordinationBackend } from '../coordination/resolve.js';

export async function heartbeatAgentTask(
  id: string,
  input: { nodeId: string; leaseVersion: number; leaseMs?: number },
): Promise<AgentTaskRecord | null> {
  await ensureAgentTaskGraphStore();
  const db = getDb();
  const leaseMs = Math.max(1_000, Math.min(10 * 60_000, Math.floor(input.leaseMs ?? 30_000)));
  const rows = await db.query<AgentTaskRow>(
    `
    UPDATE agent_tasks
    SET lease_expires_at = now() + ($4::text || ' milliseconds')::interval,
        updated_at = now()
    WHERE id = $1
      AND status = 'running'
      AND claimed_by_node_id = $2
      AND lease_version = $3
      AND lease_expires_at > now()
    RETURNING *
  `,
    [id, input.nodeId, input.leaseVersion, leaseMs],
  );
  return rows.rows[0] ? rowToTask(rows.rows[0]) : null;
}

export async function recoverExpiredAgentTasks(reason = 'lease_expired'): Promise<AgentTaskRecord[]> {
  await ensureAgentTaskGraphStore();
  return recoverExpiredAgentTaskRows(reason);
}

export async function recoverExpiredAgentTasksWithAdvisoryLock(
  reason = 'lease_expired',
): Promise<{ lockAcquired: boolean; recovered: AgentTaskRecord[] }> {
  await ensureAgentTaskGraphStore();
  const backend = await resolveCoordinationBackend();
  const result = await backend.lock.withLock(
    'agent-task-recovery',
    () => recoverExpiredAgentTaskRows(reason),
  );
  if (result === null) {
    return { lockAcquired: false, recovered: [] };
  }
  return { lockAcquired: true, recovered: result };
}

async function recoverExpiredAgentTaskRows(reason: string): Promise<AgentTaskRecord[]> {
  const rows = await getDb().query<AgentTaskRow>(
    `
    WITH expired AS (
      SELECT task.id,
             (SELECT count(*)::integer FROM task_attempts attempt WHERE attempt.task_id = task.id) AS attempt_count
      FROM agent_tasks task
      WHERE task.status = 'running'
        AND task.lease_expires_at IS NOT NULL
        AND task.lease_expires_at < now()
      FOR UPDATE SKIP LOCKED
    )
    UPDATE agent_tasks task
    SET status = CASE WHEN expired.attempt_count >= task.max_attempts THEN 'failed' ELSE 'queued' END,
        claimed_by_node_id = NULL,
        lease_expires_at = NULL,
        completed_at = CASE WHEN expired.attempt_count >= task.max_attempts THEN now() ELSE NULL END,
        metadata_json = metadata_json || jsonb_build_object(
          'recoveryReason', $1::text,
          'leaseRecoveryExhausted', expired.attempt_count >= task.max_attempts,
          'recoveredAttemptCount', expired.attempt_count
        ),
        updated_at = now()
    FROM expired
    WHERE task.id = expired.id
    RETURNING task.*
  `,
    [reason],
  );
  return rows.rows.map(rowToTask);
}
