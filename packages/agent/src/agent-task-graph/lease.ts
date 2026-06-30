import { getDb, withDbClient } from '@los/infra/db';
import { ensureAgentTaskGraphStore, type AgentTaskRecord, type AgentTaskRow, rowToTask } from '../agent-task-graph.js';
import { resolveCoordinationBackend } from '../coordination/resolve.js';

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
): Promise<{ lockAcquired: boolean; recovered: AgentTaskRecord[] }> {
  await ensureAgentTaskGraphStore();
  const backend = await resolveCoordinationBackend();
  const result = await backend.lock.withLock('agent-task-recovery', async () => {
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
  });
  if (result === null) {
    return { lockAcquired: false, recovered: [] };
  }
  return { lockAcquired: true, recovered: result };
}
