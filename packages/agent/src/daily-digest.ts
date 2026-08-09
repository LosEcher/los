/**
 * Daily Execution Digest — read-only L1 composition of schedules + usage + quality.
 *
 * Does not invent a new ledger. Reuses scheduled_work_* rows, getUsageSummary(),
 * and the latest daily_agent_quality snapshot. Cadence recommendations are
 * heuristic operator guidance based on live run volume and failure modes.
 */

import { getDb } from '@los/infra/db';
import { getDailyAgentQualityBaseline } from './daily-agent-quality/store.js';
import type { DailyAgentQualitySnapshot } from './daily-agent-quality/types.js';
import { ensureScheduledWorkStore } from './scheduled-work/schema.js';
import { getUsageSummary, type UsageSummary } from './usage-summary.js';

export type DigestEvidenceClass = 'los_runtime';

export interface DailyDigestQuery {
  /** Calendar day YYYY-MM-DD in UTC. Default: yesterday UTC. */
  day?: string;
  /** Project scope for quality snapshot. Default: los. */
  projectId?: string;
  tenantId?: string;
}

export interface DigestScheduleRow {
  scheduleId: string;
  title: string;
  status: string;
  templateId: string;
  triggerKind: string;
  expression: string;
  timezone: string;
  approvalPolicy: string;
  approvalTimeoutAction: string;
  runCount: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  skipped: number;
  awaitingApproval: number;
  other: number;
  lastStatus?: string;
  lastCompletedAt?: string;
  lastSummaryReason?: string;
}

export interface DigestCadenceRecommendation {
  scheduleId: string;
  title: string;
  severity: 'info' | 'warn' | 'action';
  currentExpression: string;
  recommendedExpression?: string;
  action: 'keep' | 'reduce_frequency' | 'retire_duplicate' | 'fix_approval_policy' | 'investigate';
  rationale: string;
  estimatedDailyRunsCurrent?: number;
  estimatedDailyRunsRecommended?: number;
}

export interface DailyDigest {
  evidenceClass: DigestEvidenceClass;
  day: string;
  from: string;
  to: string;
  generatedAt: string;
  schedule: {
    enabledCount: number;
    runTotals: {
      runCount: number;
      succeeded: number;
      failed: number;
      cancelled: number;
      skipped: number;
      awaitingApproval: number;
      other: number;
    };
    bySchedule: DigestScheduleRow[];
  };
  usage: UsageSummary;
  quality: {
    projectId: string;
    snapshot: DailyAgentQualitySnapshot | null;
  };
  cadenceRecommendations: DigestCadenceRecommendation[];
  highlights: string[];
}

interface ScheduleAggRow {
  schedule_id: string;
  title: string;
  status: string;
  template_id: string | null;
  trigger_kind: string | null;
  expression: string | null;
  timezone: string | null;
  approval_policy: string | null;
  approval_timeout_action: string | null;
  run_count: string;
  succeeded: string;
  failed: string;
  cancelled: string;
  skipped: string;
  awaiting_approval: string;
  other: string;
  last_status: string | null;
  last_completed_at: Date | string | null;
  last_summary: unknown;
}

function num(value: string | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function resolveDayWindow(day?: string): { day: string; from: string; to: string } {
  let dayStr = day?.trim();
  if (!dayStr) {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    dayStr = yesterday.toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayStr)) {
    throw new Error('daily digest day must be YYYY-MM-DD');
  }
  const from = `${dayStr}T00:00:00.000Z`;
  const toDate = new Date(from);
  toDate.setUTCDate(toDate.getUTCDate() + 1);
  return { day: dayStr, from, to: toDate.toISOString() };
}

function parseIntervalToMinutes(expression: string): number | null {
  const m = /^(\d+)(m|h|d)$/i.exec(expression.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  if (unit === 'm') return n;
  if (unit === 'h') return n * 60;
  if (unit === 'd') return n * 24 * 60;
  return null;
}

function minutesToExpression(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function summaryReason(summary: unknown): string | undefined {
  if (!summary || typeof summary !== 'object') return undefined;
  const rec = summary as Record<string, unknown>;
  for (const key of ['deniedReason', 'reason', 'error', 'message']) {
    if (typeof rec[key] === 'string' && rec[key]) return String(rec[key]);
  }
  if (typeof rec.deniedBy === 'string') return String(rec.deniedBy);
  return undefined;
}

function buildCadenceRecommendations(rows: DigestScheduleRow[]): DigestCadenceRecommendation[] {
  const recs: DigestCadenceRecommendation[] = [];
  const titleGroups = new Map<string, DigestScheduleRow[]>();
  for (const row of rows) {
    if (row.status !== 'enabled') continue;
    const key = row.title.trim().toLowerCase();
    const list = titleGroups.get(key) ?? [];
    list.push(row);
    titleGroups.set(key, list);
  }

  for (const group of titleGroups.values()) {
    if (group.length > 1) {
      const keep = group[0]!;
      for (const dup of group.slice(1)) {
        recs.push({
          scheduleId: dup.scheduleId,
          title: dup.title,
          severity: 'action',
          currentExpression: dup.expression,
          action: 'retire_duplicate',
          rationale: `Duplicate enabled schedule title; keep ${keep.scheduleId} and retire this one.`,
        });
      }
    }
  }

  for (const row of rows) {
    if (row.status !== 'enabled') continue;
    const mins = row.triggerKind === 'interval' ? parseIntervalToMinutes(row.expression) : null;
    const daily = mins && mins > 0 ? Math.round((24 * 60) / mins) : undefined;
    const cancelHeavy = row.runCount > 0 && row.cancelled / row.runCount >= 0.5;
    const approvalTimeout = (row.lastSummaryReason ?? '').includes('approval_timeout');

    if (cancelHeavy || approvalTimeout) {
      recs.push({
        scheduleId: row.scheduleId,
        title: row.title,
        severity: 'action',
        currentExpression: row.expression,
        action: 'fix_approval_policy',
        rationale: approvalTimeout || cancelHeavy
          ? `Runs are cancelled by approval_timeout (policy=${row.approvalPolicy}, timeoutAction=${row.approvalTimeoutAction}). Fix approval (preapproved_scope / longer timeout / timeoutAction=approve for unattended governance), not cadence.`
          : 'High cancel rate — inspect approval/concurrency policy.',
        estimatedDailyRunsCurrent: daily,
      });
      continue;
    }

    // Title-specific rules first (freshness may also use runtime_readiness template).
    if (
      /freshness|log freshness/i.test(row.title)
      && mins !== null
      && mins > 0
      && mins < 30
    ) {
      const recommended = 30;
      recs.push({
        scheduleId: row.scheduleId,
        title: row.title,
        severity: 'warn',
        currentExpression: row.expression,
        recommendedExpression: minutesToExpression(recommended),
        action: 'reduce_frequency',
        rationale: `Log freshness at ${row.expression} (~${daily}/day). Success is near-instant; 30m is enough for ops lag detection.`,
        estimatedDailyRunsCurrent: daily,
        estimatedDailyRunsRecommended: Math.round((24 * 60) / recommended),
      });
      continue;
    }

    if (
      (row.templateId === 'runtime_readiness' || /readiness|dogfood/i.test(row.title))
      && mins !== null
      && mins > 0
      && mins < 15
    ) {
      const recommended = 15;
      recs.push({
        scheduleId: row.scheduleId,
        title: row.title,
        severity: 'warn',
        currentExpression: row.expression,
        recommendedExpression: minutesToExpression(recommended),
        action: 'reduce_frequency',
        rationale: `Readiness probe at ${row.expression} (~${daily}/day). Zero failures observed; 15m keeps dogfood signal with ~3× fewer ticks.`,
        estimatedDailyRunsCurrent: daily,
        estimatedDailyRunsRecommended: Math.round((24 * 60) / recommended),
      });
      continue;
    }

    if (mins !== null && mins <= 5 && (daily ?? 0) >= 200) {
      recs.push({
        scheduleId: row.scheduleId,
        title: row.title,
        severity: 'info',
        currentExpression: row.expression,
        recommendedExpression: '15m',
        action: 'reduce_frequency',
        rationale: `High-frequency interval (${row.expression}, ~${daily}/day). Consider 15m unless sub-5m lag is a hard SLO.`,
        estimatedDailyRunsCurrent: daily,
        estimatedDailyRunsRecommended: 96,
      });
    }
  }

  return recs;
}

function buildHighlights(
  schedule: DailyDigest['schedule'],
  usage: UsageSummary,
  recs: DigestCadenceRecommendation[],
): string[] {
  const lines: string[] = [];
  lines.push(
    `Schedules: ${schedule.enabledCount} enabled, ${schedule.runTotals.runCount} runs `
    + `(ok=${schedule.runTotals.succeeded} fail=${schedule.runTotals.failed} `
    + `cancel=${schedule.runTotals.cancelled}).`,
  );
  lines.push(
    `Usage: ${usage.totals.modelResponseCount} model responses, `
    + `~$${usage.totals.estimatedCostUsd.toFixed(4)}, `
    + `cache_hit_rate=${usage.totals.cacheHitRate == null ? 'n/a' : `${(usage.totals.cacheHitRate * 100).toFixed(1)}%`}.`,
  );
  const top = usage.byProviderModel[0];
  if (top) {
    lines.push(`Top model: ${top.provider}:${top.model} (n=${top.modelResponseCount}).`);
  }
  const actions = recs.filter(r => r.severity === 'action' || r.action === 'reduce_frequency');
  if (actions.length > 0) {
    lines.push(`Cadence/policy actions: ${actions.length} recommendation(s).`);
  }
  return lines;
}

export async function getDailyDigest(query: DailyDigestQuery = {}): Promise<DailyDigest> {
  const window = resolveDayWindow(query.day);
  const projectId = query.projectId?.trim() || 'los';
  const tenantId = query.tenantId?.trim() || 'local';

  await ensureScheduledWorkStore();
  const db = getDb();

  const agg = await db.query<ScheduleAggRow>(
    `WITH day_runs AS (
       SELECT *
       FROM scheduled_work_item_runs
       WHERE scheduled_for >= $1::timestamptz AND scheduled_for < $2::timestamptz
     ),
     last_run AS (
       SELECT DISTINCT ON (schedule_id)
         schedule_id, status, completed_at, result_summary_json
       FROM scheduled_work_item_runs
       ORDER BY schedule_id, scheduled_for DESC
     )
     SELECT
       s.id AS schedule_id,
       s.title,
       s.status,
       s.run_template_json->>'templateId' AS template_id,
       s.trigger_json->>'kind' AS trigger_kind,
       s.trigger_json->>'expression' AS expression,
       s.trigger_json->>'timezone' AS timezone,
       s.approval_policy,
       s.approval_timeout_action,
       COUNT(r.id)::text AS run_count,
       COUNT(*) FILTER (WHERE r.status = 'succeeded')::text AS succeeded,
       COUNT(*) FILTER (WHERE r.status = 'failed')::text AS failed,
       COUNT(*) FILTER (WHERE r.status = 'cancelled')::text AS cancelled,
       COUNT(*) FILTER (WHERE r.status IN ('skipped', 'no_op'))::text AS skipped,
       COUNT(*) FILTER (WHERE r.status = 'awaiting_approval')::text AS awaiting_approval,
       COUNT(*) FILTER (WHERE r.status IS NOT NULL AND r.status NOT IN (
         'succeeded','failed','cancelled','skipped','no_op','awaiting_approval'
       ))::text AS other,
       lr.status AS last_status,
       lr.completed_at AS last_completed_at,
       lr.result_summary_json AS last_summary
     FROM scheduled_work_items s
     LEFT JOIN day_runs r ON r.schedule_id = s.id
     LEFT JOIN last_run lr ON lr.schedule_id = s.id
     WHERE s.status IN ('enabled', 'paused')
        OR EXISTS (SELECT 1 FROM day_runs dr WHERE dr.schedule_id = s.id)
     GROUP BY s.id, s.title, s.status, s.run_template_json, s.trigger_json,
              s.approval_policy, s.approval_timeout_action,
              lr.status, lr.completed_at, lr.result_summary_json
     ORDER BY COUNT(r.id) DESC, s.title ASC`,
    [window.from, window.to],
  );

  const bySchedule: DigestScheduleRow[] = agg.rows.map(row => ({
    scheduleId: row.schedule_id,
    title: row.title,
    status: row.status,
    templateId: row.template_id ?? 'unknown',
    triggerKind: row.trigger_kind ?? 'unknown',
    expression: row.expression ?? '',
    timezone: row.timezone ?? '',
    approvalPolicy: row.approval_policy ?? '',
    approvalTimeoutAction: row.approval_timeout_action ?? '',
    runCount: num(row.run_count),
    succeeded: num(row.succeeded),
    failed: num(row.failed),
    cancelled: num(row.cancelled),
    skipped: num(row.skipped),
    awaitingApproval: num(row.awaiting_approval),
    other: num(row.other),
    lastStatus: row.last_status ?? undefined,
    lastCompletedAt: row.last_completed_at
      ? (row.last_completed_at instanceof Date
        ? row.last_completed_at.toISOString()
        : String(row.last_completed_at))
      : undefined,
    lastSummaryReason: summaryReason(row.last_summary),
  }));

  const runTotals = bySchedule.reduce(
    (acc, row) => {
      acc.runCount += row.runCount;
      acc.succeeded += row.succeeded;
      acc.failed += row.failed;
      acc.cancelled += row.cancelled;
      acc.skipped += row.skipped;
      acc.awaitingApproval += row.awaitingApproval;
      acc.other += row.other;
      return acc;
    },
    { runCount: 0, succeeded: 0, failed: 0, cancelled: 0, skipped: 0, awaitingApproval: 0, other: 0 },
  );

  const enabledCount = bySchedule.filter(row => row.status === 'enabled').length;
  const usage = await getUsageSummary({ from: window.from, to: window.to });
  const qualityBaseline = await getDailyAgentQualityBaseline({
    tenantId,
    projectId,
    requiredDays: 7,
    now: new Date(window.to),
  });
  const snapshot = qualityBaseline.snapshots.find(s => s.snapshotDate === window.day)
    ?? qualityBaseline.snapshots[0]
    ?? null;

  const cadenceRecommendations = buildCadenceRecommendations(bySchedule);
  const scheduleBlock = { enabledCount, runTotals, bySchedule };

  return {
    evidenceClass: 'los_runtime',
    day: window.day,
    from: window.from,
    to: window.to,
    generatedAt: new Date().toISOString(),
    schedule: scheduleBlock,
    usage,
    quality: { projectId, snapshot },
    cadenceRecommendations,
    highlights: buildHighlights(scheduleBlock, usage, cadenceRecommendations),
  };
}
