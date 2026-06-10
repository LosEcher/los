/**
 * @los/agent/cancellation — Cross-process task cancellation via PostgreSQL.
 *
 * When a gateway needs to cancel a task running on another gateway or executor,
 * it writes a cancellation request. Running task loops poll for cancellation
 * during their heartbeat interval.
 */

import { getDb } from '@los/infra/db';

export interface CancellationRequest {
  taskRunId: string;
  reason: string;
  requestedBy: string;
  requestedAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cancellation_requests (
  task_run_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT '',
  requested_by TEXT NOT NULL DEFAULT '',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cancellation_requests_requested_at
  ON cancellation_requests(requested_at);
`;

let _initialized = false;

export async function ensureCancellationStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(SCHEMA);
  _initialized = true;
}

export async function requestCancellation(
  taskRunId: string,
  reason: string,
  requestedBy: string,
): Promise<void> {
  await ensureCancellationStore();
  const db = getDb();
  await db.query(
    `INSERT INTO cancellation_requests (task_run_id, reason, requested_by)
     VALUES ($1, $2, $3) ON CONFLICT (task_run_id) DO NOTHING`,
    [taskRunId, reason, requestedBy],
  );
}

export async function pollCancellation(taskRunId: string): Promise<CancellationRequest | null> {
  await ensureCancellationStore();
  const db = getDb();
  const rows = await db.query<{ task_run_id: string; reason: string; requested_by: string; requested_at: Date }>(
    'SELECT * FROM cancellation_requests WHERE task_run_id = $1 LIMIT 1',
    [taskRunId],
  );
  const row = rows.rows[0];
  if (!row) return null;
  return {
    taskRunId: row.task_run_id,
    reason: row.reason,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at instanceof Date ? row.requested_at.toISOString() : String(row.requested_at),
  };
}

export async function clearCancellation(taskRunId: string): Promise<void> {
  await ensureCancellationStore();
  const db = getDb();
  await db.query('DELETE FROM cancellation_requests WHERE task_run_id = $1', [taskRunId]);
}
