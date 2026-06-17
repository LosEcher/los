/**
 * @los/agent/dead-letter — Dead Letter Queue for failed and expired task runs.
 *
 * Provides persistent storage of unrecoverable task failures so operators
 * can inspect, acknowledge, and optionally replay them.
 *
 * Integration points:
 * - recoverExpiredTaskRuns: lease-expired tasks → DLQ
 * - runScheduledAgentTask catch: max-attempts exhausted → DLQ
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '@los/infra/db';
import { loadTaskRun, type TaskRunRecord } from './task-runs.js';
import { appendSessionEvent, type SessionEventWrite } from './session-events.js';

// ── Types ──────────────────────────────────────────────────

export type DLQReason = 'lease_expired' | 'max_attempts' | 'unrecoverable_error';

export interface DeadLetterEventRecord {
  id: string;
  taskRunId: string | null;
  runSpecId: string | null;
  reason: DLQReason;
  originalError: string | null;
  eventPayload: Record<string, unknown>;
  acknowledgedAt: string | null;
  createdAt: string;
}

export interface ListDeadLetterOptions {
  acknowledged?: boolean;
  reason?: DLQReason;
  limit?: number;
}

// ── Schema ─────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dead_letter_events (
  id TEXT PRIMARY KEY,
  task_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  run_spec_id TEXT REFERENCES run_specs(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  original_error TEXT,
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dead_letter_unacknowledged
  ON dead_letter_events(created_at DESC)
  WHERE acknowledged_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_dead_letter_task_run
  ON dead_letter_events(task_run_id);

CREATE INDEX IF NOT EXISTS idx_dead_letter_reason
  ON dead_letter_events(reason);
`;

let _initialized = false;

export async function ensureDeadLetterStore(): Promise<void> {
  if (_initialized) return;
  await getDb().exec(SCHEMA);
  _initialized = true;
}

// ── Write ──────────────────────────────────────────────────

export async function writeDeadLetterEvent(input: {
  taskRunId?: string;
  runSpecId?: string;
  reason: DLQReason;
  originalError?: string;
  eventPayload?: Record<string, unknown>;
}): Promise<DeadLetterEventRecord> {
  await ensureDeadLetterStore();
  const db = getDb();
  const id = `dlq-${randomUUID()}`;
  const rows = await db.query<DeadLetterRow>(
    `
    INSERT INTO dead_letter_events (id, task_run_id, run_spec_id, reason, original_error, event_payload)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    RETURNING *
  `,
    [
      id,
      input.taskRunId ?? null,
      input.runSpecId ?? null,
      input.reason,
      input.originalError ?? null,
      JSON.stringify(input.eventPayload ?? {}),
    ],
  );
  const record = rowToRecord(assertRow(rows.rows[0]));

  // Emit operator_attention event
  await appendSessionEvent({
    sessionId: `dlq-${id}`,
    type: 'operator_attention_required',
    source: 'dead_letter',
    payload: {
      event: 'operator_attention_required',
      dlqEventId: id,
      taskRunId: input.taskRunId,
      runSpecId: input.runSpecId,
      reason: input.reason,
      originalError: input.originalError,
      severity: 'high',
    },
  });

  return record;
}

export async function writeDeadLetterForExpiredTasks(
  tasks: TaskRunRecord[],
  reason: DLQReason = 'lease_expired',
): Promise<DeadLetterEventRecord[]> {
  if (tasks.length === 0) return [];
  const records: DeadLetterEventRecord[] = [];
  for (const task of tasks) {
    const record = await writeDeadLetterEvent({
      taskRunId: task.id,
      runSpecId: task.runSpecId ?? undefined,
      reason,
      eventPayload: {
        taskStatus: task.status,
        lastError: task.metadata?.error,
        recoveryReason: task.metadata?.recoveryReason,
        attempt: task.attempt,
        sessionId: task.sessionId,
        provider: task.provider,
        model: task.model,
      },
    });
    records.push(record);
  }
  return records;
}

// ── Read ───────────────────────────────────────────────────

export async function listDeadLetterEvents(
  options: ListDeadLetterOptions = {},
): Promise<DeadLetterEventRecord[]> {
  await ensureDeadLetterStore();
  const db = getDb();
  const limit = normalizeLimit(options.limit);
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.acknowledged === false || options.acknowledged === undefined) {
    clauses.push('acknowledged_at IS NULL');
  } else if (options.acknowledged === true) {
    clauses.push('acknowledged_at IS NOT NULL');
  }

  if (options.reason) {
    params.push(options.reason);
    clauses.push(`reason = $${params.length}`);
  }

  params.push(limit);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await db.query<DeadLetterRow>(
    `
    SELECT *
    FROM dead_letter_events
    ${where}
    ORDER BY created_at DESC
    LIMIT $${params.length}
  `,
    params,
  );
  return rows.rows.map(rowToRecord);
}

export async function acknowledgeDeadLetterEvent(id: string): Promise<DeadLetterEventRecord | null> {
  await ensureDeadLetterStore();
  const db = getDb();
  const rows = await db.query<DeadLetterRow>(
    `
    UPDATE dead_letter_events
    SET acknowledged_at = now()
    WHERE id = $1 AND acknowledged_at IS NULL
    RETURNING *
  `,
    [id],
  );
  return rows.rows[0] ? rowToRecord(rows.rows[0]) : null;
}

// ── Helpers ────────────────────────────────────────────────

type DeadLetterRow = {
  id: string;
  task_run_id: string | null;
  run_spec_id: string | null;
  reason: string;
  original_error: string | null;
  event_payload: Record<string, unknown> | string;
  acknowledged_at: Date | string | null;
  created_at: Date | string;
};

function rowToRecord(row: DeadLetterRow): DeadLetterEventRecord {
  return {
    id: row.id,
    taskRunId: row.task_run_id,
    runSpecId: row.run_spec_id,
    reason: row.reason as DLQReason,
    originalError: row.original_error,
    eventPayload: typeof row.event_payload === 'string'
      ? JSON.parse(row.event_payload) as Record<string, unknown>
      : row.event_payload,
    acknowledgedAt: row.acknowledged_at ? toIsoString(row.acknowledged_at) : null,
    createdAt: toIsoString(row.created_at),
  };
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('dead_letter write returned no row');
  return row;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeLimit(value: unknown): number {
  const parsed = Number(value ?? 50);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.max(1, Math.min(500, Math.floor(parsed)));
}
