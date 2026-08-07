import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';

import { ensureRunEvalStore } from '../run-evals.js';
import { ensureSessionEventStore } from '../session-events.js';
import { ensureTaskRunStore } from '../task-runs.js';
import { ensureScheduledWorkStore } from '../scheduled-work/schema.js';
import { getWorkItemVerificationCoverage, listInboxEntries } from '../work-items/projection.js';
import {
  _summarizeInbox,
  _summarizeProviderQuality,
  _summarizeRecovery,
  _summarizeSchedule,
  _summarizeVerification,
} from './metrics.js';
import { getDailyAgentQualityBaseline, upsertDailyAgentQualitySnapshot } from './store.js';
import type {
  CaptureDailyAgentQualityInput,
  DailyAgentQualityBaseline,
  DailyAgentQualitySnapshot,
  DailyQualityMetricSources,
} from './types.js';

const log = getLogger('daily-agent-quality');

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BACKFILL_DAYS = 14;

export async function captureDailyAgentQuality(input: CaptureDailyAgentQualityInput): Promise<{
  snapshot: DailyAgentQualitySnapshot;
  evidenceWindow: DailyAgentQualityBaseline['evidenceWindow'];
}> {
  const tenantId = input.tenantId ?? 'local';
  const capturedAt = input.capturedAt ?? new Date();
  const windowEnd = capturedAt;
  const windowStart = new Date(capturedAt.getTime() - (input.windowMs ?? DEFAULT_WINDOW_MS));
  await Promise.all([
    ensureScheduledWorkStore(),
    ensureTaskRunStore(),
    ensureSessionEventStore(),
    ensureRunEvalStore(),
  ]);
  const sources = await loadMetricSources({ tenantId, projectId: input.projectId, windowStart, windowEnd });
  const snapshot = await upsertDailyAgentQualitySnapshot({
    tenantId,
    projectId: input.projectId,
    snapshotDate: capturedAt.toISOString().slice(0, 10),
    capturedAt: capturedAt.toISOString(),
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    inbox: _summarizeInbox(sources.inboxEntries, capturedAt),
    schedule: _summarizeSchedule(sources.scheduleRuns),
    recovery: _summarizeRecovery(sources),
    verification: _summarizeVerification(sources.verification),
    providerQuality: _summarizeProviderQuality(sources.providerEvals),
  });
  const baseline = await getDailyAgentQualityBaseline({
    tenantId,
    projectId: input.projectId,
    requiredDays: 28,
    now: capturedAt,
  });
  return { snapshot, evidenceWindow: baseline.evidenceWindow };
}

/**
 * Backfill quality snapshots for dates missing in the recent window
 * (2026-08-07 B 项). Snapshots are captured by the gateway in-process
 * maintenance loop, so days when the gateway was offline are permanently
 * missing and the gap breaks self_bootstrap trend detection (the observed
 * 2026-07-28~08-03 7-day gap). Window-based metrics (schedule / recovery /
 * provider evals) are rebuilt from persisted run tables and are exact;
 * inbox and verification reflect current state and cannot be rebuilt, so
 * they are recorded empty rather than contaminating history with today's
 * state. Only dates strictly before today are backfilled (today's snapshot
 * is produced by the regular capture).
 */
export async function backfillDailyAgentQualitySnapshots(input: {
  tenantId?: string;
  projectId: string;
  now?: Date;
  maxBackfillDays?: number;
}): Promise<{ backfilled: string[] }> {
  const tenantId = input.tenantId ?? 'local';
  const now = input.now ?? new Date();
  const maxDays = Math.min(30, Math.max(1, Math.floor(input.maxBackfillDays ?? DEFAULT_BACKFILL_DAYS)));
  await Promise.all([
    ensureScheduledWorkStore(),
    ensureTaskRunStore(),
    ensureSessionEventStore(),
    ensureRunEvalStore(),
  ]);
  const db = getDb();
  const existing = await db.query<{ d: string }>(
    `SELECT DISTINCT snapshot_date::text AS d FROM daily_agent_quality_snapshots
     WHERE tenant_id=$1 AND project_id=$2`,
    [tenantId, input.projectId],
  );
  const have = new Set(existing.rows.map(row => row.d));
  const today = now.toISOString().slice(0, 10);
  const missing: string[] = [];
  for (let offset = 1; offset <= maxDays; offset += 1) {
    const day = new Date(now.getTime() - offset * DEFAULT_WINDOW_MS).toISOString().slice(0, 10);
    if (day >= today) continue;
    if (!have.has(day)) missing.push(day);
  }
  missing.sort();

  const backfilled: string[] = [];
  for (const day of missing) {
    const capturedAt = new Date(`${day}T12:00:00.000Z`);
    const windowStart = new Date(capturedAt.getTime() - DEFAULT_WINDOW_MS);
    const sources = await loadMetricSources({
      tenantId,
      projectId: input.projectId,
      windowStart,
      windowEnd: capturedAt,
    });
    const snapshot = await upsertDailyAgentQualitySnapshot({
      tenantId,
      projectId: input.projectId,
      snapshotDate: day,
      capturedAt: capturedAt.toISOString(),
      windowStart: windowStart.toISOString(),
      windowEnd: capturedAt.toISOString(),
      inbox: EMPTY_INBOX_METRICS,
      schedule: _summarizeSchedule(sources.scheduleRuns),
      recovery: _summarizeRecovery({ ...sources, inboxEntries: [] }),
      verification: EMPTY_VERIFICATION_METRICS,
      providerQuality: _summarizeProviderQuality(sources.providerEvals),
    });
    void snapshot;
    backfilled.push(day);
  }
  if (backfilled.length > 0) {
    log.info(`Daily agent quality: backfilled ${backfilled.length} missing snapshot date(s) for ${tenantId}/${input.projectId}: ${backfilled.join(', ')}`);
  }
  return { backfilled };
}

const EMPTY_INBOX_METRICS = {
  actionableCount: 0, approvalRequired: 0, recoveryRequired: 0,
  verificationBlocked: 0, reviewReady: 0, running: 0, unknown: 0,
  over24h: 0, over72h: 0,
};

const EMPTY_VERIFICATION_METRICS = {
  workItems: 0, required: 0, succeeded: 0, skipped: 0,
  failed: 0, pending: 0, missing: 0, coverage: 1,
};

async function loadMetricSources(input: {
  tenantId: string;
  projectId: string;
  windowStart: Date;
  windowEnd: Date;
}): Promise<DailyQualityMetricSources> {
  const db = getDb();
  const [inboxEntries, verification, scheduleRows, taskRows, recoveryRows, evalRows] = await Promise.all([
    listInboxEntries({ tenantId: input.tenantId, projectId: input.projectId, limit: 1000 }),
    getWorkItemVerificationCoverage({ tenantId: input.tenantId, projectId: input.projectId }),
    db.query<ScheduledRunRow>(
      `SELECT r.* FROM scheduled_work_item_runs r
       JOIN scheduled_work_items s ON s.id=r.schedule_id
       WHERE s.tenant_id=$1 AND s.project_id=$2 AND r.scheduled_for >= $3 AND r.scheduled_for < $4
       ORDER BY r.scheduled_for`,
      [input.tenantId, input.projectId, input.windowStart, input.windowEnd],
    ),
    db.query<{ attempt: number; status: string }>(
      `SELECT attempt,status FROM task_runs
       WHERE COALESCE(tenant_id,'local')=$1 AND project_id=$2 AND attempt > 1
         AND updated_at >= $3 AND updated_at < $4`,
      [input.tenantId, input.projectId, input.windowStart, input.windowEnd],
    ),
    db.query<{ count: string | number }>(
      `SELECT count(*)::integer AS count FROM session_events
       WHERE COALESCE(tenant_id,'local')=$1 AND project_id=$2
         AND type LIKE '%recovery%' AND created_at >= $3 AND created_at < $4`,
      [input.tenantId, input.projectId, input.windowStart, input.windowEnd],
    ),
    db.query<ProviderEvalRow>(
      `SELECT e.success,e.latency_ms,e.retry_count,e.tool_error_count,e.model_cost
       FROM run_evals e JOIN run_specs r ON r.id=e.run_spec_id
       WHERE COALESCE(r.tenant_id,'local')=$1 AND r.project_id=$2
         AND e.created_at >= $3 AND e.created_at < $4`,
      [input.tenantId, input.projectId, input.windowStart, input.windowEnd],
    ),
  ]);
  return {
    inboxEntries,
    verification,
    scheduleRuns: scheduleRows.rows.map(scheduledRunFromRow),
    taskRetries: taskRows.rows,
    recoveryEvents: Number(recoveryRows.rows[0]?.count ?? 0),
    providerEvals: evalRows.rows.map(row => ({
      success: row.success,
      latencyMs: row.latency_ms ?? undefined,
      retryCount: row.retry_count,
      toolErrorCount: row.tool_error_count,
      modelCost: row.model_cost === null ? undefined : Number(row.model_cost),
    })),
  };
}

type ScheduledRunRow = {
  id: string; schedule_id: string; scheduled_for: Date | string; trigger_kind: string; status: string;
  attempt_count: number; max_attempts: number; claim_owner: string | null; lease_expires_at: Date | string | null;
  work_item_id: string | null; run_spec_id: string | null; task_run_id: string | null; result_summary_json: unknown;
  error: string | null; started_at: Date | string | null; completed_at: Date | string | null;
  created_at: Date | string; updated_at: Date | string;
};

type ProviderEvalRow = {
  success: boolean;
  latency_ms: number | null;
  retry_count: number;
  tool_error_count: number;
  model_cost: string | number | null;
};

function scheduledRunFromRow(row: ScheduledRunRow): DailyQualityMetricSources['scheduleRuns'][number] {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    scheduledFor: toIso(row.scheduled_for),
    triggerKind: row.trigger_kind as 'scheduled' | 'manual' | 'retry',
    status: row.status as DailyQualityMetricSources['scheduleRuns'][number]['status'],
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    claimOwner: row.claim_owner ?? undefined,
    leaseExpiresAt: optionalIso(row.lease_expires_at),
    workItemId: row.work_item_id ?? undefined,
    runSpecId: row.run_spec_id ?? undefined,
    taskRunId: row.task_run_id ?? undefined,
    resultSummary: asObject(row.result_summary_json),
    error: row.error ?? undefined,
    startedAt: optionalIso(row.started_at),
    completedAt: optionalIso(row.completed_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function optionalIso(value: Date | string | null): string | undefined {
  return value === null ? undefined : toIso(value);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
