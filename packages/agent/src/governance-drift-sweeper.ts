/**
 * Governance Drift Sweeper — cross-audit drift detection.
 *
 * Compares consecutive governance sweep results to detect regressions:
 *   - todo seed/db drift growing (seed-only or db-only count increasing)
 *   - status constraint violations increasing
 *   - error frequency spikes
 *   - architecture graph structural changes
 *   - hotspot illegal status / stale fixture increases
 *
 * Integrated into governance sweeper pipeline. Each run compares against
 * the previous baseline stored in governance_jobs.resultSummary.
 */

import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import type { GovernanceJob, GovernanceJobType, CreateGovernanceJobInput, GovernanceSweepResult } from './governance-jobs-types.js';

const log = getLogger('governance-drift');

// ── Types ───────────────────────────────────────────────

export interface DriftCheckpoint {
  jobId: string;
  jobType: GovernanceJobType;
  capturedAt: string;
  metrics: Record<string, number>;
  findCount: number;
  rules: DriftRule[];
}

export interface DriftRule {
  metric: string;
  direction: 'higher' | 'lower' | 'any';
  /** Percentage change that triggers a drift alert (e.g., 20 = 20%) */
  thresholdPercent: number;
  label: string;
}

export interface DriftFinding {
  metric: string;
  previousValue: number;
  currentValue: number;
  changePercent: number;
  direction: 'increase' | 'decrease';
  thresholdPercent: number;
  severity: 'low' | 'medium' | 'high';
  label: string;
}

export interface DriftReport {
  baselineJobId: string;
  currentJobId: string;
  jobType: GovernanceJobType;
  findings: DriftFinding[];
  hasDrift: boolean;
  hasNewRules: boolean;
}

// ── Default drift rules per job type ────────────────────

const DRIFT_RULES: Record<GovernanceJobType, DriftRule[]> = {
  consistency_audit: [
    { metric: 'seedOnly', direction: 'higher', thresholdPercent: 1, label: 'Seed-only todos increased' },
    { metric: 'dbOnly', direction: 'higher', thresholdPercent: 10, label: 'DB-only orphan todos increased >10%' },
    { metric: 'statusDrift', direction: 'higher', thresholdPercent: 1, label: 'Status drift count increased' },
    { metric: 'unvalidated', direction: 'higher', thresholdPercent: 5, label: 'Unvalidated constraints increased' },
  ],
  hotspot: [
    { metric: 'illegalStatusCount', direction: 'higher', thresholdPercent: 1, label: 'Illegal task run status increased' },
    { metric: 'staleFixtureCount', direction: 'higher', thresholdPercent: 20, label: 'Stale fixture count increased >20%' },
    { metric: 'recentErrors24h', direction: 'higher', thresholdPercent: 50, label: '24h error spike >50%' },
  ],
  architecture_drift: [
    { metric: 'hasStructuralChanges', direction: 'any', thresholdPercent: 0, label: 'Architecture graph changed' },
    { metric: 'nodeCount', direction: 'any', thresholdPercent: 15, label: 'Graph node count changed >15%' },
    { metric: 'edgeCount', direction: 'any', thresholdPercent: 15, label: 'Graph edge count changed >15%' },
  ],
  memory_integrity: [
    { metric: 'integrityIssues', direction: 'higher', thresholdPercent: 1, label: 'Memory integrity issues increased' },
  ],
  memory_retention: [
    { metric: 'retentionIssues', direction: 'higher', thresholdPercent: 1, label: 'Memory retention issues increased' },
  ],
  file_size: [
    { metric: 'filesOver600', direction: 'higher', thresholdPercent: 1, label: 'Files over 600 line limit increased' },
    { metric: 'filesOver400', direction: 'higher', thresholdPercent: 10, label: 'Files over 400 line threshold increased >10%' },
  ],
  reflection: [],
  branch_cleanup: [],
  related_project_scan: [],
  supply_chain_audit: [],
  static_analysis: [],
  performance_audit: [],
  migration_drift_fix: [],
  event_retention: [],
  code_topology_audit: [],
  dead_letter: [],
};

// ── Core ─────────────────────────────────────────────────

function extractMetrics(jobType: GovernanceJobType, resultSummary: Record<string, unknown>): Record<string, number> {
  const metrics: Record<string, number> = {};

  if (jobType === 'consistency_audit') {
    const tr = resultSummary.todoReconciliation as Record<string, unknown> | undefined;
    if (tr) {
      metrics.seedOnly = Number(tr.seedOnly ?? 0);
      metrics.dbOnly = Number(tr.dbOnly ?? 0);
      metrics.statusDrift = Number(tr.statusDrift ?? 0);
    }
    const sc = resultSummary.statusConstraints as Record<string, unknown> | undefined;
    if (sc) {
      metrics.unvalidated = Number(sc.unvalidated ?? 0);
      metrics.invalidRows = Number(sc.invalidRows ?? 0);
    }
  }

  if (jobType === 'hotspot') {
    const rc = resultSummary.runtimeCleanup as Record<string, unknown> | undefined;
    if (rc) {
      metrics.illegalStatusCount = Number(rc.illegalStatusCount ?? 0);
      metrics.staleFixtureCount = Number(rc.staleFixtureCount ?? 0);
    }
    const ef = resultSummary.errorFrequency as Record<string, unknown> | undefined;
    if (ef) {
      metrics.recentErrors24h = Number(ef.recentErrors24h ?? 0);
    }
  }

  if (jobType === 'architecture_drift') {
    metrics.nodeCount = Number(resultSummary.nodeCount ?? -1);
    metrics.edgeCount = Number(resultSummary.edgeCount ?? -1);
    metrics.hasStructuralChanges = resultSummary.hasStructuralChanges === true ? 1 : 0;
  }

  if (jobType === 'memory_integrity') {
    metrics.integrityIssues = Number(resultSummary.integrityIssues ?? 0);
  }

  if (jobType === 'memory_retention') {
    metrics.retentionIssues = Number(resultSummary.retentionIssues ?? 0);
  }

  if (jobType === 'file_size') {
    metrics.filesOver600 = Number(resultSummary.filesOver600Count ?? resultSummary.filesOver600 ?? 0);
    metrics.filesOver400 = Number(resultSummary.filesOver400Count ?? resultSummary.filesOver400 ?? 0);
  }

  return metrics;
}

export async function detectGovernanceDrift(job: {
  id: string;
  jobType: GovernanceJobType;
  resultSummary: Record<string, unknown> | undefined;
}): Promise<DriftReport | null> {
  if (!job.resultSummary || Object.keys(job.resultSummary).length === 0) {
    return null;
  }

  const rules = DRIFT_RULES[job.jobType] ?? [];
  if (rules.length === 0) return null;

  // Load previous sweep of same job type
  const db = getDb();
  const prevRows = await db.query<{
    id: string;
    job_type: GovernanceJobType;
    result_summary_json: unknown;
    last_run_at: string;
  }>(
    `
    SELECT id, job_type, result_summary_json, last_run_at
    FROM governance_jobs
    WHERE job_type = $1
      AND id != $2
      AND result_summary_json IS NOT NULL
    ORDER BY last_run_at DESC
    LIMIT 1
  `,
    [job.jobType, job.id],
  );

  if (prevRows.rows.length === 0) return null;

  const prev = prevRows.rows[0];
  const prevSummary = typeof prev.result_summary_json === 'string'
    ? JSON.parse(prev.result_summary_json)
    : (prev.result_summary_json as Record<string, unknown>) ?? {};

  const currentMetrics = extractMetrics(job.jobType, job.resultSummary ?? {});
  const previousMetrics = extractMetrics(job.jobType, prevSummary);

  const findings: DriftFinding[] = [];

  for (const rule of rules) {
    const prevVal = previousMetrics[rule.metric];
    const currVal = currentMetrics[rule.metric];
    if (prevVal === undefined || currVal === undefined) continue;

    if (currVal === prevVal) continue;

    if (rule.direction === 'lower' && currVal > prevVal) continue;
    if (rule.direction === 'higher' && currVal < prevVal) continue;

    // 'any' direction or matched direction — check threshold
    const change = prevVal === 0 ? (currVal === 0 ? 0 : 100) : Math.abs((currVal - prevVal) / prevVal * 100);
    if (change < rule.thresholdPercent) continue;

    findings.push({
      metric: rule.metric,
      previousValue: prevVal,
      currentValue: currVal,
      changePercent: Math.round(change * 10) / 10,
      direction: currVal > prevVal ? 'increase' : 'decrease',
      thresholdPercent: rule.thresholdPercent,
      severity: change >= 50 ? 'high' : change >= 20 ? 'medium' : 'low',
      label: rule.label,
    });
  }

  return {
    baselineJobId: prev.id,
    currentJobId: job.id,
    jobType: job.jobType,
    findings,
    hasDrift: findings.length > 0,
    hasNewRules: false,
  };
}

/**
 * Run drift detection across due governance jobs.
 *
 * Called after the main audit step in runGovernanceSweep. For each completed
 * job, compares its result summary against the previous baseline.
 *
 * Returns findings as a GovernanceJob resultSummary so it's stored in the
 * audit trail alongside the regular sweep output.
 */
export async function sweepGovernanceDrift(opts: {
  dryRun?: boolean;
  tenantId?: string;
  projectId?: string;
} = {}): Promise<{
  jobsChecked: number;
  jobsWithDrift: number;
  totalFindings: number;
  findings: Record<string, DriftFinding[]>;
}> {
  const db = getDb();
  const dryRun = opts.dryRun !== false;

  // Get jobs that ran in the last hour (recent sweep)
  const rows = await db.query<{
    id: string;
    job_type: GovernanceJobType;
    result_summary_json: unknown;
    last_run_at: string;
  }>(
    `
    SELECT id, job_type, result_summary_json, last_run_at
    FROM governance_jobs
    WHERE result_summary_json IS NOT NULL
      AND last_run_at > now() - INTERVAL '2 hours'
    ORDER BY last_run_at DESC
    LIMIT 50
  `,
    [],
  );

  const findings: Record<string, DriftFinding[]> = {};
  let jobsChecked = 0;
  let jobsWithDrift = 0;

  for (const row of rows.rows) {
    const summary = typeof row.result_summary_json === 'string'
      ? JSON.parse(row.result_summary_json)
      : (row.result_summary_json as Record<string, unknown>) ?? {};

    const job: {
      id: string;
      jobType: GovernanceJobType;
      resultSummary: Record<string, unknown>;
    } = {
      id: row.id,
      jobType: row.job_type,
      resultSummary: summary,
    };

    try {
      const drift = await detectGovernanceDrift(job);
      jobsChecked++;
      if (drift && drift.hasDrift) {
        jobsWithDrift++;
        findings[job.id] = drift.findings;
        log.warn(`Drift: ${job.jobType} (${job.id}) — ${drift.findings.length} findings`);
      }
    } catch (err) {
      log.warn(`Drift detection failed for ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { jobsChecked, jobsWithDrift, totalFindings: jobsWithDrift, findings };
}

/**
 * Convenience: combine a sweep run with drift detection.
 */
export async function sweepWithDriftDetection(opts?: {
  jobTypes?: GovernanceJobType[];
  dryRun?: boolean;
  tenantId?: string;
  projectId?: string;
  now?: Date;
}): Promise<{
  sweep: GovernanceSweepResult;
  drift: Record<string, unknown>;
}> {
  const { runGovernanceSweep } = await import('./governance-jobs.js');
  const sweep = await runGovernanceSweep(opts);
  const drift = await sweepGovernanceDrift({ dryRun: opts?.dryRun, tenantId: opts?.tenantId, projectId: opts?.projectId });
  return { sweep, drift };
}
