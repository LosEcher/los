import { randomUUID } from 'node:crypto';

import { getDb, withDbClient } from '@los/infra/db';

import {
  nextOccurrenceAfterSlot,
  previewScheduledOccurrences,
  shouldSkipLateRun,
  validateScheduledTrigger,
  validateScheduledWorkItemInput,
} from './policy.js';
import { ensureScheduledWorkStore } from './schema.js';
import type {
  CreateScheduledWorkItemInput, ScheduledWorkItem, ScheduledWorkItemRun,
  ScheduledWorkRunStatus, UpdateScheduledWorkItemInput,
} from './types.js';

const ACTIVE_SQL = "('queued','claimed','running','awaiting_approval')";
const LEGAL_TRANSITIONS: Record<ScheduledWorkRunStatus, ScheduledWorkRunStatus[]> = {
  queued: ['claimed', 'skipped', 'cancelled'],
  claimed: ['running', 'awaiting_approval', 'skipped', 'failed', 'cancelled'],
  running: ['claimed', 'succeeded', 'no_op', 'failed', 'cancelled'],
  awaiting_approval: ['claimed', 'cancelled'],
  failed: ['claimed'],
  succeeded: [], no_op: [], skipped: [], cancelled: [],
};

export async function createScheduledWorkItem(input: CreateScheduledWorkItemInput): Promise<ScheduledWorkItem> {
  await ensureScheduledWorkStore();
  validateScheduledWorkItemInput(input);
  const now = input.now ?? new Date();
  const nextRunAt = previewScheduledOccurrences(input.trigger, now, 1)[0];
  if (!nextRunAt) throw new Error('trigger has no future occurrence');
  const rows = await getDb().query<ScheduledWorkRow>(
    `INSERT INTO scheduled_work_items (
       id, tenant_id, project_id, user_id, title, trigger_json, run_template_json,
       approval_policy, concurrency_policy, catch_up_policy, max_concurrent_runs,
       max_lateness_ms, max_attempts, retry_backoff_ms, failure_threshold,
       next_run_at, metadata_json
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
     RETURNING *`,
    [
      `schedule-${randomUUID()}`, input.tenantId ?? 'local', input.projectId.trim(), input.userId ?? null,
      input.title.trim(), JSON.stringify(input.trigger), JSON.stringify(input.runTemplate),
      input.approvalPolicy ?? 'read_only_auto', input.concurrencyPolicy ?? 'skip', input.catchUpPolicy ?? 'skip',
      boundedInt(input.maxConcurrentRuns, 1, 8, 1), boundedInt(input.maxLatenessMs, 0, 31 * 86_400_000, 3_600_000),
      boundedInt(input.maxAttempts, 1, 10, 2), boundedInt(input.retryBackoffMs, 1_000, 86_400_000, 60_000),
      boundedInt(input.failureThreshold, 1, 20, 3), nextRunAt, JSON.stringify(input.metadata ?? {}),
    ],
  );
  return scheduleFromRow(rows.rows[0]!);
}

export async function loadScheduledWorkItem(id: string): Promise<ScheduledWorkItem | null> {
  await ensureScheduledWorkStore();
  const rows = await getDb().query<ScheduledWorkRow>('SELECT * FROM scheduled_work_items WHERE id=$1', [id]);
  return rows.rows[0] ? scheduleFromRow(rows.rows[0]) : null;
}

export async function listScheduledWorkItems(input: { projectId?: string; status?: string; limit?: number } = {}): Promise<ScheduledWorkItem[]> {
  await ensureScheduledWorkStore();
  const rows = await getDb().query<ScheduledWorkRow>(
    `SELECT * FROM scheduled_work_items
     WHERE ($1::text IS NULL OR project_id=$1) AND ($2::text IS NULL OR status=$2)
     ORDER BY updated_at DESC LIMIT $3`,
    [input.projectId ?? null, input.status ?? null, Math.min(200, Math.max(1, input.limit ?? 50))],
  );
  return rows.rows.map(scheduleFromRow);
}

export async function updateScheduledWorkItem(id: string, input: UpdateScheduledWorkItemInput): Promise<ScheduledWorkItem | null> {
  const current = await loadScheduledWorkItem(id);
  if (!current) return null;
  if (
    current.runTemplate.templateId === 'scheduled_feed_analysis'
    && input.approvalPolicy !== undefined
    && input.approvalPolicy !== 'preapproved_scope'
  ) throw new Error('scheduled_feed_analysis requires preapproved_scope');
  if (input.trigger) validateScheduledTrigger(input.trigger);
  const trigger = input.trigger ?? current.trigger;
  const nextRunAt = input.trigger || (input.status === 'enabled' && current.status !== 'enabled')
    ? previewScheduledOccurrences(trigger, new Date(), 1)[0] ?? current.nextRunAt
    : current.nextRunAt;
  const rows = await getDb().query<ScheduledWorkRow>(
    `UPDATE scheduled_work_items SET
       title=$2, status=$3, trigger_json=$4::jsonb, approval_policy=$5,
       concurrency_policy=$6, catch_up_policy=$7, max_concurrent_runs=$8,
       max_lateness_ms=$9, failure_threshold=$10, metadata_json=$11::jsonb,
       next_run_at=$12, revision=revision+1, updated_at=now()
     WHERE id=$1 RETURNING *`,
    [id, input.title?.trim() || current.title, input.status ?? current.status, JSON.stringify(trigger),
      input.approvalPolicy ?? current.approvalPolicy, input.concurrencyPolicy ?? current.concurrencyPolicy,
      input.catchUpPolicy ?? current.catchUpPolicy,
      boundedInt(input.maxConcurrentRuns, 1, 8, current.maxConcurrentRuns),
      boundedInt(input.maxLatenessMs, 0, 31 * 86_400_000, current.maxLatenessMs),
      boundedInt(input.failureThreshold, 1, 20, current.failureThreshold),
      JSON.stringify(input.metadata ?? current.metadata), nextRunAt],
  );
  return rows.rows[0] ? scheduleFromRow(rows.rows[0]) : null;
}

export async function listScheduledWorkItemRuns(scheduleId: string, limit = 50): Promise<ScheduledWorkItemRun[]> {
  await ensureScheduledWorkStore();
  const rows = await getDb().query<ScheduledWorkRunRow>(
    'SELECT * FROM scheduled_work_item_runs WHERE schedule_id=$1 ORDER BY scheduled_for DESC LIMIT $2',
    [scheduleId, Math.min(200, Math.max(1, limit))],
  );
  return rows.rows.map(runFromRow);
}

export async function loadScheduledWorkItemRun(id: string): Promise<ScheduledWorkItemRun | null> {
  await ensureScheduledWorkStore();
  const rows = await getDb().query<ScheduledWorkRunRow>('SELECT * FROM scheduled_work_item_runs WHERE id=$1', [id]);
  return rows.rows[0] ? runFromRow(rows.rows[0]) : null;
}

export async function claimDueScheduledWorkItems(input: {
  ownerId: string; now?: Date; leaseMs?: number; limit?: number;
}): Promise<ScheduledWorkItemRun[]> {
  await ensureScheduledWorkStore();
  const claimed: ScheduledWorkItemRun[] = [];
  const now = input.now ?? new Date();
  await withDbClient(async client => {
    await client.query('BEGIN');
    try {
      for (let index = 0; index < Math.min(50, Math.max(1, input.limit ?? 10)); index += 1) {
        const selected = await client.query<ScheduledWorkRow>(
          `SELECT * FROM scheduled_work_items
           WHERE status='enabled' AND circuit_state IN ('closed','half_open') AND next_run_at <= $1
           ORDER BY next_run_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, [now],
        );
        const row = selected.rows[0];
        if (!row) break;
        const schedule = scheduleFromRow(row);
        const slot = new Date(schedule.nextRunAt);
        const active = await client.query<{ count: string; queued: string }>(
          `SELECT count(*)::text AS count,
             count(*) FILTER (WHERE status='queued')::text AS queued
           FROM scheduled_work_item_runs WHERE schedule_id=$1 AND status IN ${ACTIVE_SQL}`,
          [schedule.id],
        );
        const activeCount = Number(active.rows[0]?.count ?? 0);
        const queuedCount = Number(active.rows[0]?.queued ?? 0);
        const late = shouldSkipLateRun(slot, now, schedule.maxLatenessMs, schedule.catchUpPolicy);
        let status: ScheduledWorkRunStatus = 'claimed';
        let reason: string | undefined;
        if (late) { status = 'skipped'; reason = 'skipped_late'; }
        else if (activeCount >= schedule.maxConcurrentRuns) {
          if (schedule.concurrencyPolicy === 'queue_one' && queuedCount === 0) status = 'queued';
          else { status = 'skipped'; reason = 'concurrency_limit'; }
        }
        const inserted = await client.query<ScheduledWorkRunRow>(
          `INSERT INTO scheduled_work_item_runs (
             id,schedule_id,scheduled_for,trigger_kind,status,attempt_count,max_attempts,
             claim_owner,lease_expires_at,result_summary_json,completed_at
           ) VALUES ($1,$2,$3,'scheduled',$4,1,$5,$6,$7,$8::jsonb,$9)
           ON CONFLICT (schedule_id,scheduled_for) DO NOTHING RETURNING *`,
          [`schedule-run-${randomUUID()}`, schedule.id, slot, status, schedule.maxAttempts,
            status === 'claimed' ? input.ownerId : null,
            status === 'claimed' ? new Date(now.getTime() + (input.leaseMs ?? 60_000)) : null,
            JSON.stringify(reason ? { reason } : {}), status === 'skipped' ? now : null],
        );
        const next = nextOccurrenceAfterSlot(schedule.trigger, slot);
        await client.query(
          `UPDATE scheduled_work_items SET status=$2,next_run_at=$3,updated_at=now() WHERE id=$1`,
          [schedule.id, next ? schedule.status : 'retired', next ?? slot],
        );
        if (inserted.rows[0]) claimed.push(runFromRow(inserted.rows[0]));
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  return claimed;
}

export async function createManualScheduledWorkRun(input: {
  scheduleId: string; ownerId: string; scheduledFor?: Date; leaseMs?: number;
}): Promise<ScheduledWorkItemRun> {
  const schedule = await loadScheduledWorkItem(input.scheduleId);
  if (!schedule) throw new Error('schedule not found');
  if (schedule.status === 'retired') throw new Error('retired schedule cannot be triggered');
  if (schedule.circuitState === 'open') throw new Error('schedule circuit is open');
  const slot = input.scheduledFor ?? new Date();
  const rows = await getDb().query<ScheduledWorkRunRow>(
    `INSERT INTO scheduled_work_item_runs (
       id,schedule_id,scheduled_for,trigger_kind,status,attempt_count,max_attempts,claim_owner,lease_expires_at
     ) VALUES ($1,$2,$3,'manual','claimed',1,$4,$5,$6)
     ON CONFLICT (schedule_id,scheduled_for) DO UPDATE SET updated_at=scheduled_work_item_runs.updated_at
     RETURNING *`,
    [`schedule-run-${randomUUID()}`, schedule.id, slot, schedule.maxAttempts, input.ownerId,
      new Date(slot.getTime() + (input.leaseMs ?? 60_000))],
  );
  return runFromRow(rows.rows[0]!);
}

export async function claimQueuedScheduledWorkRuns(input: {
  ownerId: string; now?: Date; leaseMs?: number; limit?: number;
}): Promise<ScheduledWorkItemRun[]> {
  await ensureScheduledWorkStore();
  const now = input.now ?? new Date();
  const rows = await getDb().query<ScheduledWorkRunRow>(
    `WITH selected AS (
       SELECT r.id FROM scheduled_work_item_runs r
       JOIN scheduled_work_items s ON s.id=r.schedule_id
       WHERE r.status='queued' AND s.status='enabled' AND s.circuit_state IN ('closed','half_open')
         AND NOT EXISTS (
           SELECT 1 FROM scheduled_work_item_runs active
           WHERE active.schedule_id=r.schedule_id AND active.status IN ('claimed','running','awaiting_approval')
         )
       ORDER BY r.scheduled_for,r.id LIMIT $1 FOR UPDATE OF r SKIP LOCKED
     )
     UPDATE scheduled_work_item_runs r SET status='claimed',claim_owner=$2,
       lease_expires_at=$3,updated_at=now()
     FROM selected WHERE r.id=selected.id RETURNING r.*`,
    [Math.min(50, Math.max(1, input.limit ?? 10)), input.ownerId,
      new Date(now.getTime() + (input.leaseMs ?? 60_000))],
  );
  return rows.rows.map(runFromRow);
}

export async function recoverExpiredScheduledWorkRuns(input: {
  ownerId: string; now?: Date; leaseMs?: number; limit?: number;
}): Promise<{ recovered: ScheduledWorkItemRun[]; exhausted: ScheduledWorkItemRun[] }> {
  await ensureScheduledWorkStore();
  const now = input.now ?? new Date();
  const limit = Math.min(50, Math.max(1, input.limit ?? 10));
  const recovered = await getDb().query<ScheduledWorkRunRow>(
    `WITH selected AS (
       SELECT r.id FROM scheduled_work_item_runs r
       JOIN scheduled_work_items s ON s.id=r.schedule_id
       WHERE r.status IN ('claimed','running') AND r.lease_expires_at <= $1
         AND r.attempt_count < r.max_attempts AND s.circuit_state IN ('closed','half_open')
       ORDER BY r.lease_expires_at,r.id LIMIT $2 FOR UPDATE OF r SKIP LOCKED
     )
     UPDATE scheduled_work_item_runs r SET status='claimed',trigger_kind='retry',
       attempt_count=attempt_count+1,claim_owner=$3,lease_expires_at=$4,error=NULL,updated_at=now()
     FROM selected WHERE r.id=selected.id RETURNING r.*`,
    [now, limit, input.ownerId, new Date(now.getTime() + (input.leaseMs ?? 60_000))],
  );
  const exhausted = await getDb().query<ScheduledWorkRunRow>(
    `WITH selected AS (
       SELECT id FROM scheduled_work_item_runs
       WHERE status IN ('claimed','running') AND lease_expires_at <= $1 AND attempt_count >= max_attempts
       ORDER BY lease_expires_at,id LIMIT $2 FOR UPDATE SKIP LOCKED
     )
     UPDATE scheduled_work_item_runs r SET status='failed',error='lease expired and retry limit exhausted',
       lease_expires_at=NULL,completed_at=now(),updated_at=now()
     FROM selected WHERE r.id=selected.id RETURNING r.*`,
    [now, limit],
  );
  return { recovered: recovered.rows.map(runFromRow), exhausted: exhausted.rows.map(runFromRow) };
}

export async function retryScheduledWorkRun(input: {
  runId: string; ownerId: string; now?: Date; leaseMs?: number;
}): Promise<ScheduledWorkItemRun> {
  const current = await loadScheduledWorkItemRun(input.runId);
  if (!current) throw new Error('scheduled work run not found');
  if (current.status !== 'failed') throw new Error('only failed scheduled runs can be retried');
  if (current.attemptCount >= current.maxAttempts) throw new Error('scheduled work run retry limit exhausted');
  const schedule = await loadScheduledWorkItem(current.scheduleId);
  if (!schedule || schedule.circuitState === 'open') throw new Error('schedule circuit is open');
  const now = input.now ?? new Date();
  const rows = await getDb().query<ScheduledWorkRunRow>(
    `UPDATE scheduled_work_item_runs SET status='claimed',trigger_kind='retry',
       attempt_count=attempt_count+1,claim_owner=$2,lease_expires_at=$3,error=NULL,completed_at=NULL,updated_at=now()
     WHERE id=$1 AND status='failed' AND attempt_count < max_attempts RETURNING *`,
    [input.runId, input.ownerId, new Date(now.getTime() + (input.leaseMs ?? 60_000))],
  );
  if (!rows.rows[0]) throw new Error('scheduled work run changed concurrently');
  return runFromRow(rows.rows[0]);
}

export async function transitionScheduledWorkRun(
  id: string,
  to: ScheduledWorkRunStatus,
  patch: {
    ownerId?: string;
    leaseExpiresAt?: Date;
    resultSummary?: Record<string, unknown>;
    error?: string;
    workItemId?: string;
    runSpecId?: string;
    taskRunId?: string;
  } = {},
): Promise<ScheduledWorkItemRun> {
  const current = await loadScheduledWorkItemRun(id);
  if (!current) throw new Error('scheduled work run not found');
  if (!LEGAL_TRANSITIONS[current.status].includes(to)) throw new Error(`illegal scheduled work run transition: ${current.status} -> ${to}`);
  const terminal = ['succeeded', 'no_op', 'skipped', 'failed', 'cancelled'].includes(to);
  const rows = await getDb().query<ScheduledWorkRunRow>(
    `UPDATE scheduled_work_item_runs SET status=$2,claim_owner=COALESCE($3,claim_owner),
       lease_expires_at=$4,result_summary_json=COALESCE($5::jsonb,result_summary_json),
       error=$6,work_item_id=COALESCE($7,work_item_id),
       run_spec_id=COALESCE($10,run_spec_id),task_run_id=COALESCE($11,task_run_id),
       started_at=CASE WHEN $2='running' THEN COALESCE(started_at,now()) ELSE started_at END,
       completed_at=CASE WHEN $8 THEN now() ELSE completed_at END,updated_at=now()
     WHERE id=$1 AND status=$9 RETURNING *`,
    [id, to, patch.ownerId ?? null, patch.leaseExpiresAt ?? null,
      patch.resultSummary ? JSON.stringify(patch.resultSummary) : null, patch.error ?? null,
      patch.workItemId ?? null, terminal, current.status, patch.runSpecId ?? null, patch.taskRunId ?? null],
  );
  if (!rows.rows[0]) throw new Error('scheduled work run changed concurrently');
  return runFromRow(rows.rows[0]);
}

export async function recordScheduledRunOutcome(input: {
  scheduleId: string; status: 'succeeded' | 'no_op' | 'failed'; recoveryWorkItemId?: string;
}): Promise<{ schedule: ScheduledWorkItem; circuitOpened: boolean }> {
  const current = await loadScheduledWorkItem(input.scheduleId);
  if (!current) throw new Error('schedule not found');
  const failures = input.status === 'failed' ? current.consecutiveFailures + 1 : 0;
  const noOps = input.status === 'no_op' ? current.consecutiveNoOps + 1 : 0;
  const shouldOpen = input.status === 'failed' && failures >= current.failureThreshold;
  const circuitOpened = shouldOpen && current.circuitState !== 'open';
  const rows = await getDb().query<ScheduledWorkRow>(
    `UPDATE scheduled_work_items SET consecutive_failures=$2,consecutive_no_ops=$3,
       circuit_state=$4,circuit_opened_at=CASE WHEN $4='open' THEN COALESCE(circuit_opened_at,now()) ELSE NULL END,
       recovery_work_item_id=COALESCE($5,recovery_work_item_id),updated_at=now() WHERE id=$1 RETURNING *`,
    [input.scheduleId, failures, noOps, shouldOpen ? 'open' : 'closed', input.recoveryWorkItemId ?? null],
  );
  return { schedule: scheduleFromRow(rows.rows[0]!), circuitOpened };
}

export async function attachScheduledRunWorkItem(runId: string, workItemId: string): Promise<void> {
  await getDb().query('UPDATE scheduled_work_item_runs SET work_item_id=$2,updated_at=now() WHERE id=$1', [runId, workItemId]);
}

export async function attachScheduleRecoveryWorkItem(scheduleId: string, workItemId: string): Promise<void> {
  await getDb().query(
    'UPDATE scheduled_work_items SET recovery_work_item_id=$2,updated_at=now() WHERE id=$1',
    [scheduleId, workItemId],
  );
}

function boundedInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`numeric policy must be between ${min} and ${max}`);
  return value;
}

type ScheduledWorkRow = Record<string, unknown> & {
  id: string; tenant_id: string; project_id: string; user_id: string | null; title: string; status: string;
  trigger_json: unknown; run_template_json: unknown; approval_policy: string; concurrency_policy: string; catch_up_policy: string;
  max_concurrent_runs: number; max_lateness_ms: number; max_attempts: number; retry_backoff_ms: number;
  failure_threshold: number; next_run_at: Date | string; circuit_state: string; circuit_opened_at: Date | string | null;
  consecutive_failures: number; consecutive_no_ops: number; recovery_work_item_id: string | null; revision: number;
  metadata_json: unknown; created_at: Date | string; updated_at: Date | string;
};
type ScheduledWorkRunRow = Record<string, unknown> & {
  id: string; schedule_id: string; scheduled_for: Date | string; trigger_kind: string; status: string;
  attempt_count: number; max_attempts: number; claim_owner: string | null; lease_expires_at: Date | string | null;
  work_item_id: string | null; run_spec_id: string | null; task_run_id: string | null; result_summary_json: unknown;
  error: string | null; started_at: Date | string | null; completed_at: Date | string | null;
  created_at: Date | string; updated_at: Date | string;
};

function scheduleFromRow(row: ScheduledWorkRow): ScheduledWorkItem {
  return {
    id: row.id, tenantId: row.tenant_id, projectId: row.project_id, userId: row.user_id ?? undefined,
    title: row.title, status: row.status as ScheduledWorkItem['status'],
    trigger: objectValue(row.trigger_json) as unknown as ScheduledWorkItem['trigger'],
    runTemplate: objectValue(row.run_template_json) as unknown as ScheduledWorkItem['runTemplate'],
    approvalPolicy: row.approval_policy as ScheduledWorkItem['approvalPolicy'],
    concurrencyPolicy: row.concurrency_policy as ScheduledWorkItem['concurrencyPolicy'],
    catchUpPolicy: row.catch_up_policy as ScheduledWorkItem['catchUpPolicy'],
    maxConcurrentRuns: row.max_concurrent_runs, maxLatenessMs: row.max_lateness_ms, maxAttempts: row.max_attempts,
    retryBackoffMs: row.retry_backoff_ms, failureThreshold: row.failure_threshold, nextRunAt: iso(row.next_run_at),
    circuitState: row.circuit_state as ScheduledWorkItem['circuitState'], circuitOpenedAt: optionalIso(row.circuit_opened_at),
    consecutiveFailures: row.consecutive_failures, consecutiveNoOps: row.consecutive_no_ops,
    recoveryWorkItemId: row.recovery_work_item_id ?? undefined, revision: row.revision,
    metadata: objectValue(row.metadata_json), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
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
function iso(value: Date | string): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function optionalIso(value: Date | string | null): string | undefined { return value ? iso(value) : undefined; }
