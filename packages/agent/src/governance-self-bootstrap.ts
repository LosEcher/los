/**
 * @los/agent/governance-self-bootstrap — Self-bootstrap auditor (A 项).
 *
 * Three deterministic checks that close the observation→improvement loop:
 * 1. quality_degradation: daily_agent_quality_snapshots trend — recent 3-day
 *    mean vs prior 7-day median for schedule.failureRate / inbox.reviewReady /
 *    inbox.recoveryRequired; degradation > threshold yields a finding so the
 *    sweeper can create an improvement todo (previously snapshots were
 *    collected for 72 days and never consumed).
 * 2. todo_lifecycle: in_progress todos older than staleDays without a recent
 *    statusReview are flagged so long-running tasks get periodic refresh
 *    (the 2026-08-07 zombie-todo finding: 6 in_progress items untouched for
 *    weeks). Items reviewed within the last reviewedWithinDays are skipped.
 * 3. todo_outcome_drift (AP12): open todos whose linked task_run / feed-analysis
 *    dispatch is already terminal are auto-reconciled (when dryRun=false) so
 *    zombie in_progress rows cannot accumulate past one sweep cycle.
 */
import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import type { GovernanceJob } from './governance-jobs-types.js';
import { reconcileOpenTodosFromOutcomes } from './todo-outcome-sync.js';

const log = getLogger('governance-self-bootstrap');

export interface SelfBootstrapFinding {
  dimension: 'quality_degradation' | 'todo_lifecycle' | 'todo_outcome_drift';
  severity: 'info' | 'warn' | 'high';
  detail: string;
}

interface QualityMetric {
  key: string;
  label: string;
  degradeWhenHigher: boolean;
  thresholdPercent: number;
  minAbsolute?: number;
}

const QUALITY_METRICS: QualityMetric[] = [
  { key: 'schedule.failureRate', label: 'scheduled run failure rate', degradeWhenHigher: true, thresholdPercent: 30, minAbsolute: 0.02 },
  { key: 'inbox.reviewReady', label: 'inbox items ready for review', degradeWhenHigher: true, thresholdPercent: 30, minAbsolute: 5 },
  { key: 'inbox.recoveryRequired', label: 'recovery-required inbox items', degradeWhenHigher: true, thresholdPercent: 30, minAbsolute: 2 },
  { key: 'schedule.succeeded', label: 'scheduled run successes', degradeWhenHigher: false, thresholdPercent: 30, minAbsolute: 5 },
];

function readNested(record: Record<string, unknown>, path: string): number {
  let current: unknown = record;
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null) return 0;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'number' ? current : 0;
}

export async function runSelfBootstrapAudit(
  job: GovernanceJob,
  options: { now?: Date; dryRun?: boolean } = {},
): Promise<Record<string, unknown>> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const staleDays = Number(job.config?.staleDays ?? 14);
  const reviewedWithinDays = Number(job.config?.reviewedWithinDays ?? 7);
  const findings: SelfBootstrapFinding[] = [];
  let outcomeReconcile: Record<string, unknown> | undefined;

  // ── 1. Quality degradation trend ─────────────────────────
  try {
    const rows = await getDb().query<{ d: string; json: Record<string, unknown> }>(
      `SELECT DISTINCT ON (snapshot_date) snapshot_date::text AS d, jsonb_build_object(
         'schedule', schedule_json, 'inbox', inbox_json
       ) AS json
       FROM daily_agent_quality_snapshots
       WHERE snapshot_date >= $1::date - 10
       ORDER BY snapshot_date DESC, captured_at DESC`,
      [now],
    );
    if (rows.rows.length >= 7) {
      const sorted = [...rows.rows].sort((a, b) => a.d.localeCompare(b.d));
      const recent = sorted.slice(-3);
      const prior = sorted.slice(0, -3);
      const median = (values: number[]): number => {
        const v = [...values].sort((a, b) => a - b);
        const mid = Math.floor(v.length / 2);
        return v.length % 2 === 0 ? (v[mid - 1] + v[mid]) / 2 : v[mid];
      };
      for (const metric of QUALITY_METRICS) {
        const recentValues = recent.map(r => readNested(r.json, metric.key));
        const priorValues = prior.map(r => readNested(r.json, metric.key));
        const recentMean = recentValues.reduce((a, b) => a + b, 0) / recentValues.length;
        const priorMedian = median(priorValues);
        if (priorMedian === 0 && recentMean === 0) continue;
        const base = priorMedian === 0 ? recentMean : priorMedian;
        const changePercent = ((recentMean - priorMedian) / base) * 100;
        const degraded = metric.degradeWhenHigher
          ? changePercent > metric.thresholdPercent
          : changePercent < -metric.thresholdPercent;
        if (degraded && (metric.minAbsolute === undefined || Math.abs(recentMean - priorMedian) >= metric.minAbsolute)) {
          findings.push({
            dimension: 'quality_degradation',
            severity: changePercent > 60 ? 'high' : 'warn',
            detail: `${metric.label}: recent 3d mean=${recentMean.toFixed(2)} vs prior 7d median=${priorMedian.toFixed(2)} (${changePercent > 0 ? '+' : ''}${changePercent.toFixed(0)}%)`,
          });
        }
      }
    }
  } catch (err) {
    log.warn(`self-bootstrap quality check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── 2. Todo lifecycle staleness ─────────────────────────
  try {
    const cutoff = new Date(now.getTime() - staleDays * 24 * 3600_000);
    const rows = await getDb().query<{ id: string; title: string; updated_at: string; metadata: Record<string, unknown> }>(
      `SELECT id, title, updated_at, metadata_json AS metadata
       FROM todos
       WHERE status = 'in_progress' AND updated_at < $1
       ORDER BY updated_at`,
      [cutoff],
    );
    const reviewedCutoff = now.getTime() - reviewedWithinDays * 24 * 3600_000;
    for (const row of rows.rows) {
      const statusReview = (row.metadata?.statusReview ?? {}) as Record<string, unknown>;
      const reviewedAt = typeof statusReview.reviewedAt === 'string' ? statusReview.reviewedAt : undefined;
      if (reviewedAt && Date.parse(reviewedAt) > reviewedCutoff) continue;
      const ageDays = Math.floor((now.getTime() - new Date(row.updated_at).getTime()) / (24 * 3600_000));
      findings.push({
        dimension: 'todo_lifecycle',
        severity: ageDays > 30 ? 'warn' : 'info',
        detail: `todo ${row.id} ("${row.title.slice(0, 60)}") in_progress for ${ageDays}d without a recent statusReview`,
      });
    }
  } catch (err) {
    log.warn(`self-bootstrap todo-lifecycle check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── 3. AP12 todo outcome drift (auto-heal when not dry-run) ──
  try {
    const report = await reconcileOpenTodosFromOutcomes({
      limit: Number(job.config?.outcomeReconcileLimit ?? 100),
      dryRun,
    });
    outcomeReconcile = {
      scanned: report.scanned,
      drifted: report.drifted,
      applied: report.applied,
      dryRun: report.dryRun,
      sample: report.items.slice(0, 10).map(i => ({
        todoId: i.todoId,
        from: i.fromStatus,
        to: i.toStatus,
        source: i.source,
        applied: i.applied,
      })),
    };
    if (report.drifted > 0) {
      findings.push({
        dimension: 'todo_outcome_drift',
        severity: report.drifted > 10 ? 'warn' : 'info',
        detail: dryRun
          ? `${report.drifted} open todo(s) lag terminal task/dispatch outcomes (dry-run; not applied)`
          : `reconciled ${report.applied}/${report.drifted} open todo(s) from terminal task/dispatch outcomes`,
      });
    }
  } catch (err) {
    log.warn(`self-bootstrap todo-outcome reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    checkedAt: now.toISOString(),
    staleDays,
    reviewedWithinDays,
    dryRun,
    outcomeReconcile,
    findingCount: findings.length,
    findings,
  };
}
