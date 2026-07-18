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
import { getDb, withDbClient } from '@los/infra/db';
import type { TaskRunRecord } from './task-runs.js';
import {
  appendSessionEvent,
  ensureSessionEventStore,
  notifySessionEvent,
  type SessionEventWrite,
} from './session-events.js';

// ── Types ──────────────────────────────────────────────────

export type DLQReason = 'lease_expired' | 'max_attempts' | 'unrecoverable_error';
export type DeadLetterResolution =
  | 'replaced'
  | 'superseded'
  | 'accepted_loss'
  | 'regression_covered'
  | 'legacy_acknowledged';

export interface ResolveDeadLetterInput {
  resolution: Exclude<DeadLetterResolution, 'legacy_acknowledged'>;
  actor: string;
  note?: string;
  replacementTaskRunId?: string;
}

export interface DeadLetterEventRecord {
  id: string;
  taskRunId: string | null;
  runSpecId: string | null;
  reason: DLQReason;
  originalError: string | null;
  eventPayload: Record<string, unknown>;
  acknowledgedAt: string | null;
  requeuedTaskRunId: string | null;
  requeuedAt: string | null;
  requeueError: string | null;
  resolution: DeadLetterResolution | null;
  resolutionNote: string | null;
  replacementTaskRunId: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
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
  requeued_task_run_id TEXT,
  requeued_at TIMESTAMPTZ,
  requeue_error TEXT,
  resolution TEXT,
  resolution_note TEXT,
  replacement_task_run_id TEXT,
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE dead_letter_events ADD COLUMN IF NOT EXISTS requeued_task_run_id TEXT;
ALTER TABLE dead_letter_events ADD COLUMN IF NOT EXISTS requeued_at TIMESTAMPTZ;
ALTER TABLE dead_letter_events ADD COLUMN IF NOT EXISTS requeue_error TEXT;
ALTER TABLE dead_letter_events ADD COLUMN IF NOT EXISTS resolution TEXT;
ALTER TABLE dead_letter_events ADD COLUMN IF NOT EXISTS resolution_note TEXT;
ALTER TABLE dead_letter_events ADD COLUMN IF NOT EXISTS replacement_task_run_id TEXT;
ALTER TABLE dead_letter_events ADD COLUMN IF NOT EXISTS resolved_by TEXT;
ALTER TABLE dead_letter_events ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_dead_letter_unacknowledged
  ON dead_letter_events(created_at DESC)
  WHERE acknowledged_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_dead_letter_task_run
  ON dead_letter_events(task_run_id);

CREATE INDEX IF NOT EXISTS idx_dead_letter_reason
  ON dead_letter_events(reason);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dead_letter_requeued_task_run
  ON dead_letter_events(requeued_task_run_id)
  WHERE requeued_task_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dead_letter_retryable
  ON dead_letter_events(created_at)
  WHERE reason = 'lease_expired'
    AND acknowledged_at IS NULL
    AND requeued_task_run_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_dead_letter_resolution
  ON dead_letter_events(resolution, resolved_at DESC)
  WHERE resolution IS NOT NULL;
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
  const record = deadLetterRowToRecord(assertRow(rows.rows[0]));

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
  return rows.rows.map(deadLetterRowToRecord);
}

export async function acknowledgeDeadLetterEvent(
  id: string,
  input: ResolveDeadLetterInput,
): Promise<DeadLetterEventRecord | null> {
  const resolution = validateResolutionInput(input);
  await ensureDeadLetterStore();
  await ensureSessionEventStore();
  const resolved = await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      const rows = await client.query<DeadLetterRow>(
        `
        UPDATE dead_letter_events
        SET acknowledged_at = now(),
            resolution = $2,
            resolution_note = $3,
            replacement_task_run_id = $4,
            resolved_by = $5,
            resolved_at = now()
        WHERE id = $1 AND acknowledged_at IS NULL
        RETURNING *
      `,
        [id, resolution.resolution, resolution.note, resolution.replacementTaskRunId, resolution.actor],
      );
      const record = rows.rows[0] ? deadLetterRowToRecord(rows.rows[0]) : null;
      if (!record) {
        await client.query('ROLLBACK');
        return null;
      }
      const sessionId = typeof record.eventPayload.sessionId === 'string'
        ? record.eventPayload.sessionId
        : `dlq-${id}`;
      const event = await appendSessionEvent({
        sessionId,
        type: 'dead_letter.resolved',
        source: 'dead_letter',
        payload: {
          event: 'dead_letter.resolved',
          dlqEventId: id,
          taskRunId: record.taskRunId,
          runSpecId: record.runSpecId,
          resolution: record.resolution,
          replacementTaskRunId: record.replacementTaskRunId,
          resolvedBy: record.resolvedBy,
        },
      }, { client, notify: false });
      await client.query('COMMIT');
      return { event, record };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  if (!resolved) return null;
  await notifySessionEvent(resolved.event);
  return resolved.record;
}

// ── Helpers ────────────────────────────────────────────────

export type DeadLetterRow = {
  id: string;
  task_run_id: string | null;
  run_spec_id: string | null;
  reason: string;
  original_error: string | null;
  event_payload: Record<string, unknown> | string;
  acknowledged_at: Date | string | null;
  requeued_task_run_id: string | null;
  requeued_at: Date | string | null;
  requeue_error: string | null;
  resolution: string | null;
  resolution_note: string | null;
  replacement_task_run_id: string | null;
  resolved_by: string | null;
  resolved_at: Date | string | null;
  created_at: Date | string;
};

export function deadLetterRowToRecord(row: DeadLetterRow): DeadLetterEventRecord {
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
    requeuedTaskRunId: row.requeued_task_run_id,
    requeuedAt: row.requeued_at ? toIsoString(row.requeued_at) : null,
    requeueError: row.requeue_error,
    resolution: isDeadLetterResolution(row.resolution) ? row.resolution : null,
    resolutionNote: row.resolution_note,
    replacementTaskRunId: row.replacement_task_run_id,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at ? toIsoString(row.resolved_at) : null,
    createdAt: toIsoString(row.created_at),
  };
}

function validateResolutionInput(input: ResolveDeadLetterInput): ResolveDeadLetterInput {
  const actor = input.actor.trim();
  const note = input.note?.trim() || undefined;
  const replacementTaskRunId = input.replacementTaskRunId?.trim() || undefined;
  if (!isOperatorDeadLetterResolution(input.resolution)) {
    throw new Error('dead_letter_resolution_invalid');
  }
  if (!actor) throw new Error('dead_letter_resolution_actor_required');
  if (input.resolution === 'replaced' && !replacementTaskRunId) {
    throw new Error('dead_letter_replacement_task_run_required');
  }
  if (input.resolution === 'accepted_loss' && !note) {
    throw new Error('dead_letter_resolution_note_required');
  }
  return { resolution: input.resolution, actor, note, replacementTaskRunId };
}

function isOperatorDeadLetterResolution(value: unknown): value is ResolveDeadLetterInput['resolution'] {
  return value === 'replaced'
    || value === 'superseded'
    || value === 'accepted_loss'
    || value === 'regression_covered';
}

function isDeadLetterResolution(value: string | null): value is DeadLetterResolution {
  return value === 'replaced'
    || value === 'superseded'
    || value === 'accepted_loss'
    || value === 'regression_covered'
    || value === 'legacy_acknowledged';
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
