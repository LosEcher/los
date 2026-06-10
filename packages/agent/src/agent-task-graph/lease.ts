import { getDb, withDbClient } from '@los/infra/db';
import { ensureAgentTaskGraphStore, type AgentTaskRecord, type AgentTaskRow, rowToTask } from '../agent-task-graph.js';

export const AGENT_TASK_STARTUP_RECOVERY_LOCK_KEY = 7_602_026_002;

export async function heartbeatAgentTask(
  id: string,
  input: { nodeId?: string; leaseMs?: number } = {},
): Promise<AgentTaskRecord | null> {
  await ensureAgentTaskGraphStore();
  const db = getDb();
  const leaseMs = Math.max(1_000, Math.min(10 * 60_000, Math.floor(input.leaseMs ?? 30_000)));
  const rows = await db.query<AgentTaskRow>(
    `
    UPDATE agent_tasks
    SET claimed_by_node_id = COALESCE($2, claimed_by_node_id),
        lease_expires_at = now() + ($3::text || ' milliseconds')::interval,
        updated_at = now()
    WHERE id = $1
      AND status = 'running'
    RETURNING *
  `,
    [id, input.nodeId ?? null, leaseMs],
  );
  return rows.rows[0] ? rowToTask(rows.rows[0]) : null;
}

export async function recoverExpiredAgentTasks(reason = 'lease_expired'): Promise<AgentTaskRecord[]> {
  await ensureAgentTaskGraphStore();
  const db = getDb();
  const rows = await db.query<AgentTaskRow>(
    `
    UPDATE agent_tasks
    SET status = 'queued',
        claimed_by_node_id = NULL,
        lease_expires_at = NULL,
        metadata_json = metadata_json || $1::jsonb,
        updated_at = now()
    WHERE status = 'running'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < now()
    RETURNING *
  `,
    [JSON.stringify({ recoveryReason: reason })],
  );
  return rows.rows.map(rowToTask);
}

export async function recoverExpiredAgentTasksWithAdvisoryLock(
  reason = 'lease_expired',
  lockKey = AGENT_TASK_STARTUP_RECOVERY_LOCK_KEY,
): Promise<{ lockAcquired: boolean; recovered: AgentTaskRecord[] }> {
  await ensureAgentTaskGraphStore();
  return await withDbClient(async (client) => {
    const lock = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
      [lockKey],
    );
    if (lock.rows[0]?.acquired !== true) {
      return { lockAcquired: false, recovered: [] };
    }

    try {
      const rows = await client.query<AgentTaskRow>(
        `
        UPDATE agent_tasks
        SET status = 'queued',
            claimed_by_node_id = NULL,
            lease_expires_at = NULL,
            metadata_json = metadata_json || $1::jsonb,
            updated_at = now()
        WHERE status = 'running'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < now()
        RETURNING *
      `,
        [JSON.stringify({ recoveryReason: reason })],
      );
      return { lockAcquired: true, recovered: rows.rows.map(rowToTask) };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey]).catch(() => undefined);
    }
  });
}
