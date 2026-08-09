import { getDb } from '@los/infra/db';

import {
  claimLeaseExpiry,
  defaultScheduledWorkExecutionLeaseMs,
} from './lease.js';
import { ensureScheduledWorkStore } from './schema.js';
import { recordScheduledRunOutcome } from './store.js';
import type { ScheduledWorkItemRun, ScheduledWorkRunStatus } from './types.js';

/**
 * Active agent work for a scheduled run uses dedupe key `schedule-exec-${runId}`.
 * Recovery must not reclaim while that task (or an attached task_run_id) is still
 * queued/running — otherwise a second execute hits dedupe and false-fails.
 */
const ACTIVE_SCHEDULE_EXEC_TASK_SQL = `
  EXISTS (
    SELECT 1 FROM task_runs t
    WHERE t.status IN ('queued', 'running')
      AND (
        t.dedupe_key = 'schedule-exec-' || r.id
        OR (r.task_run_id IS NOT NULL AND t.id = r.task_run_id)
      )
  )`;

const TERMINAL_SCHEDULE_EXEC_TASK_SQL = `
  EXISTS (
    SELECT 1 FROM task_runs t
    WHERE t.status IN ('succeeded','failed','cancelled','blocked')
      AND (
        t.dedupe_key = 'schedule-exec-' || r.id
        OR (r.task_run_id IS NOT NULL AND t.id = r.task_run_id)
      )
  )`;

type ScheduledWorkRunRow = Record<string, unknown> & {
  id: string; schedule_id: string; scheduled_for: Date | string; trigger_kind: string; status: string;
  attempt_count: number; max_attempts: number; claim_owner: string | null; lease_expires_at: Date | string | null;
  work_item_id: string | null; run_spec_id: string | null; task_run_id: string | null; result_summary_json: unknown;
  error: string | null; started_at: Date | string | null; completed_at: Date | string | null;
  created_at: Date | string; updated_at: Date | string;
};

/**
 * Close schedule runs whose agent work already finished after the owning process
 * died (lease expired, task terminal). Prefer this over re-executing and
 * double-running the agent under a new attempt.
 */
async function finalizeExpiredRunsWithTerminalScheduleExecTasks(input: {
  now: Date;
  limit: number;
}): Promise<ScheduledWorkItemRun[]> {
  const rows = await getDb().query<ScheduledWorkRunRow>(
    `WITH candidates AS (
       SELECT r.id,
              t.id AS task_id,
              t.run_spec_id AS task_run_spec_id,
              t.status AS task_status
         FROM scheduled_work_item_runs r
         JOIN task_runs t ON (
           t.dedupe_key = 'schedule-exec-' || r.id
           OR (r.task_run_id IS NOT NULL AND t.id = r.task_run_id)
         )
        WHERE r.status IN ('claimed','running')
          AND r.lease_expires_at <= $1
          AND t.status IN ('succeeded','failed','cancelled','blocked')
        ORDER BY r.lease_expires_at, r.id
        LIMIT $2
        FOR UPDATE OF r SKIP LOCKED
     )
     UPDATE scheduled_work_item_runs r
        SET status = CASE WHEN c.task_status = 'succeeded' THEN 'succeeded' ELSE 'failed' END,
            task_run_id = COALESCE(r.task_run_id, c.task_id),
            run_spec_id = COALESCE(r.run_spec_id, c.task_run_spec_id),
            error = CASE
              WHEN c.task_status = 'succeeded' THEN NULL
              ELSE COALESCE(r.error, 'adopted terminal schedule-exec task: ' || c.task_status)
            END,
            result_summary_json = COALESCE(r.result_summary_json, '{}'::jsonb)
              || jsonb_build_object('adoptedTaskRunId', c.task_id, 'adoptedTaskStatus', c.task_status),
            lease_expires_at = NULL,
            completed_at = now(),
            updated_at = now()
       FROM candidates c
      WHERE r.id = c.id
      RETURNING r.*`,
    [input.now, input.limit],
  );
  return rows.rows.map(runFromRow);
}

export async function recoverExpiredScheduledWorkRuns(input: {
  ownerId: string; now?: Date; leaseMs?: number; limit?: number;
}): Promise<{ recovered: ScheduledWorkItemRun[]; exhausted: ScheduledWorkItemRun[] }> {
  await ensureScheduledWorkStore();
  const now = input.now ?? new Date();
  const limit = Math.min(50, Math.max(1, input.limit ?? 10));
  // First seal runs whose agent work already finished (crash after task terminal).
  const finalized = await finalizeExpiredRunsWithTerminalScheduleExecTasks({ now, limit });
  for (const run of finalized) {
    const status = run.status === 'succeeded' ? 'succeeded' as const : 'failed' as const;
    await recordScheduledRunOutcome({ scheduleId: run.scheduleId, status });
  }
  const recovered = await getDb().query<ScheduledWorkRunRow>(
    `WITH selected AS (
       SELECT r.id FROM scheduled_work_item_runs r
       JOIN scheduled_work_items s ON s.id=r.schedule_id
       WHERE r.status IN ('claimed','running') AND r.lease_expires_at <= $1
         AND r.attempt_count < r.max_attempts AND s.circuit_state IN ('closed','half_open')
         AND NOT (${ACTIVE_SCHEDULE_EXEC_TASK_SQL})
         AND NOT (${TERMINAL_SCHEDULE_EXEC_TASK_SQL})
       ORDER BY r.lease_expires_at,r.id LIMIT $2 FOR UPDATE OF r SKIP LOCKED
     )
     UPDATE scheduled_work_item_runs r SET status='claimed',trigger_kind='retry',
       attempt_count=attempt_count+1,claim_owner=$3,lease_expires_at=$4,error=NULL,updated_at=now()
     FROM selected WHERE r.id=selected.id RETURNING r.*`,
    [now, limit, input.ownerId, claimLeaseExpiry(now, input.leaseMs)],
  );
  const exhausted = await getDb().query<ScheduledWorkRunRow>(
    `WITH selected AS (
       SELECT r.id FROM scheduled_work_item_runs r
       WHERE r.status IN ('claimed','running') AND r.lease_expires_at <= $1
         AND r.attempt_count >= r.max_attempts
         AND NOT (${ACTIVE_SCHEDULE_EXEC_TASK_SQL})
         AND NOT (${TERMINAL_SCHEDULE_EXEC_TASK_SQL})
       ORDER BY r.lease_expires_at,r.id LIMIT $2 FOR UPDATE OF r SKIP LOCKED
     )
     UPDATE scheduled_work_item_runs r SET status='failed',error='lease expired and retry limit exhausted',
       lease_expires_at=NULL,completed_at=now(),updated_at=now()
     FROM selected WHERE r.id=selected.id RETURNING r.*`,
    [now, limit],
  );
  return { recovered: recovered.rows.map(runFromRow), exhausted: exhausted.rows.map(runFromRow) };
}

/**
 * Renew the execution lease while a template (especially scheduled_execution)
 * is still in flight. No-ops if the run left `running` or ownership moved.
 */
export async function heartbeatScheduledWorkRun(input: {
  runId: string;
  ownerId?: string | null;
  now?: Date;
  leaseMs?: number;
}): Promise<ScheduledWorkItemRun | null> {
  await ensureScheduledWorkStore();
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? defaultScheduledWorkExecutionLeaseMs();
  const rows = await getDb().query<ScheduledWorkRunRow>(
    `UPDATE scheduled_work_item_runs
        SET lease_expires_at = $2, updated_at = now()
      WHERE id = $1
        AND status = 'running'
        AND ($3::text IS NULL OR claim_owner = $3)
      RETURNING *`,
    [input.runId, new Date(now.getTime() + leaseMs), input.ownerId ?? null],
  );
  return rows.rows[0] ? runFromRow(rows.rows[0]) : null;
}

function runFromRow(row: ScheduledWorkRunRow): ScheduledWorkItemRun {
  return {
    id: row.id, scheduleId: row.schedule_id, scheduledFor: iso(row.scheduled_for),
    triggerKind: row.trigger_kind as ScheduledWorkItemRun['triggerKind'], status: row.status as ScheduledWorkRunStatus,
    attemptCount: row.attempt_count, maxAttempts: row.max_attempts, claimOwner: row.claim_owner ?? undefined,
    leaseExpiresAt: optionalIso(row.lease_expires_at), workItemId: row.work_item_id ?? undefined,
    runSpecId: row.run_spec_id ?? undefined, taskRunId: row.task_run_id ?? undefined,
    resultSummary: row.result_summary_json ? objectValue(row.result_summary_json) : undefined,
    error: row.error ?? undefined, startedAt: optionalIso(row.started_at), completedAt: optionalIso(row.completed_at),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
function optionalIso(value: Date | string | null): string | undefined {
  return value ? iso(value) : undefined;
}
