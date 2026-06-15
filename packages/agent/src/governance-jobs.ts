/**
 * @los/agent/governance-jobs — Governance job store and periodic sweeper.
 *
 * Stores governance job configuration and run summaries. The sweeper
 * checks cadence-based到期, dispatches the appropriate audit function,
 * writes results back, and creates todos for findings.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';

const log = getLogger('governance-jobs');

export type GovernanceJobType = 'consistency_audit' | 'hotspot' | 'architecture_drift';
export type GovernanceCadence = 'manual' | 'hourly' | 'daily' | 'weekly';
export type GovernanceJobStatus = 'active' | 'paused' | 'retired';

export interface GovernanceJob {
  id: string;
  jobType: GovernanceJobType;
  cadence: GovernanceCadence;
  status: GovernanceJobStatus;
  config: Record<string, unknown>;
  lastRunAt?: string;
  lastTaskRunId?: string;
  resultSummary?: Record<string, unknown>;
  dedupeKey?: string;
  tenantId?: string;
  projectId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateGovernanceJobInput {
  jobType: GovernanceJobType;
  cadence?: GovernanceCadence;
  status?: GovernanceJobStatus;
  config?: Record<string, unknown>;
  dedupeKey?: string;
  tenantId?: string;
  projectId?: string;
}

export interface UpdateGovernanceJobInput {
  cadence?: GovernanceCadence;
  status?: GovernanceJobStatus;
  config?: Record<string, unknown>;
  lastRunAt?: string;
  lastTaskRunId?: string;
  resultSummary?: Record<string, unknown>;
  dedupeKey?: string;
}

export interface ListGovernanceJobsOptions {
  jobType?: GovernanceJobType;
  cadence?: GovernanceCadence;
  status?: GovernanceJobStatus;
  tenantId?: string;
  projectId?: string;
  limit?: number;
}

export interface ListDueGovernanceJobsOptions {
  jobTypes?: GovernanceJobType[];
  tenantId?: string;
  projectId?: string;
  /** Override the cadence到期 threshold for testing. */
  now?: Date;
}

export interface GovernanceSweepJobResult {
  jobId: string;
  jobType: GovernanceJobType;
  summary: Record<string, unknown>;
  durationMs: number;
}

export interface GovernanceSweepResult {
  dryRun: boolean;
  jobsRun: number;
  jobsSkipped: number;
  findingsCreated: number;
  errors: string[];
  results: GovernanceSweepJobResult[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS governance_jobs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  cadence TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'active',
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_run_at TIMESTAMPTZ,
  last_task_run_id TEXT,
  result_summary_json JSONB,
  dedupe_key TEXT,
  tenant_id TEXT,
  project_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'governance_jobs_status_chk'
      AND conrelid = 'governance_jobs'::regclass
  ) THEN
    ALTER TABLE governance_jobs
      ADD CONSTRAINT governance_jobs_status_chk
      CHECK (status IN ('active', 'paused', 'retired'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'governance_jobs_cadence_chk'
      AND conrelid = 'governance_jobs'::regclass
  ) THEN
    ALTER TABLE governance_jobs
      ADD CONSTRAINT governance_jobs_cadence_chk
      CHECK (cadence IN ('manual', 'hourly', 'daily', 'weekly'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_gov_jobs_dedupe
  ON governance_jobs(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status = 'active';

CREATE INDEX IF NOT EXISTS idx_gov_jobs_type_status ON governance_jobs(job_type, status);
CREATE INDEX IF NOT EXISTS idx_gov_jobs_cadence ON governance_jobs(cadence, last_run_at);
CREATE INDEX IF NOT EXISTS idx_gov_jobs_tenant_project ON governance_jobs(tenant_id, project_id);
`;

let _initialized = false;

export async function ensureGovernanceJobStore(): Promise<void> {
  if (_initialized) return;
  await getDb().exec(SCHEMA);
  _initialized = true;
  log.info('Governance job store initialized');
}

// ── CRUD ─────────────────────────────────────────────────

export async function createGovernanceJob(
  input: CreateGovernanceJobInput,
): Promise<GovernanceJob> {
  await ensureGovernanceJobStore();
  const db = getDb();
  const id = `govjob-${randomUUID()}`;

  const rows = await db.query<GovernanceJobRow>(
    `INSERT INTO governance_jobs (
      id, job_type, cadence, status, config_json, dedupe_key, tenant_id, project_id
    ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
    RETURNING *`,
    [
      id,
      input.jobType,
      input.cadence ?? 'manual',
      input.status ?? 'active',
      JSON.stringify(input.config ?? {}),
      input.dedupeKey ?? null,
      input.tenantId ?? null,
      input.projectId ?? null,
    ],
  );

  return rowToJob(assertRow(rows.rows[0]));
}

export async function getGovernanceJob(id: string): Promise<GovernanceJob | null> {
  await ensureGovernanceJobStore();
  const rows = await getDb().query<GovernanceJobRow>(
    'SELECT * FROM governance_jobs WHERE id = $1',
    [id],
  );
  return rows.rows[0] ? rowToJob(rows.rows[0]) : null;
}

export async function listGovernanceJobs(
  options: ListGovernanceJobsOptions = {},
): Promise<GovernanceJob[]> {
  await ensureGovernanceJobStore();
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.jobType) {
    params.push(options.jobType);
    clauses.push(`job_type = $${params.length}`);
  }
  if (options.cadence) {
    params.push(options.cadence);
    clauses.push(`cadence = $${params.length}`);
  }
  if (options.status) {
    params.push(options.status);
    clauses.push(`status = $${params.length}`);
  }
  if (options.tenantId) {
    params.push(options.tenantId);
    clauses.push(`(tenant_id IS NULL OR tenant_id = $${params.length})`);
  }
  if (options.projectId) {
    params.push(options.projectId);
    clauses.push(`(project_id IS NULL OR project_id = $${params.length})`);
  }

  const limit = normalizeLimit(options.limit);
  params.push(limit);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = await db.query<GovernanceJobRow>(
    `SELECT * FROM governance_jobs
     ${where}
     ORDER BY created_at DESC, id
     LIMIT $${params.length}`,
    params,
  );

  return rows.rows.map(rowToJob);
}

export async function updateGovernanceJob(
  id: string,
  input: UpdateGovernanceJobInput,
): Promise<GovernanceJob | null> {
  await ensureGovernanceJobStore();
  const existing = await getGovernanceJob(id);
  if (!existing) return null;

  const db = getDb();
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [id];

  if (input.cadence !== undefined) {
    params.push(input.cadence);
    sets.push(`cadence = $${params.length}`);
  }
  if (input.status !== undefined) {
    params.push(input.status);
    sets.push(`status = $${params.length}`);
  }
  if (input.config !== undefined) {
    params.push(JSON.stringify(input.config));
    sets.push(`config_json = $${params.length}::jsonb`);
  }
  if (input.lastRunAt !== undefined) {
    params.push(input.lastRunAt);
    sets.push(`last_run_at = $${params.length}::timestamptz`);
  }
  if (input.lastTaskRunId !== undefined) {
    params.push(input.lastTaskRunId);
    sets.push(`last_task_run_id = $${params.length}`);
  }
  if (input.resultSummary !== undefined) {
    params.push(JSON.stringify(input.resultSummary));
    sets.push(`result_summary_json = $${params.length}::jsonb`);
  }
  if (input.dedupeKey !== undefined) {
    params.push(input.dedupeKey);
    sets.push(`dedupe_key = $${params.length}`);
  }

  const rows = await db.query<GovernanceJobRow>(
    `UPDATE governance_jobs SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    params,
  );

  return rows.rows[0] ? rowToJob(rows.rows[0]) : null;
}

export async function deleteGovernanceJob(id: string): Promise<boolean> {
  await ensureGovernanceJobStore();
  const result = await getDb().query<{ id: string }>(
    'DELETE FROM governance_jobs WHERE id = $1 RETURNING id',
    [id],
  );
  return result.rows.length > 0;
}

// ── Due Job Listing ──────────────────────────────────────

const CADENCE_THRESHOLDS: Record<Exclude<GovernanceCadence, 'manual'>, number> = {
  hourly: 55 * 60 * 1000,   // 55 minutes (with 5-min jitter margin)
  daily: 23 * 60 * 60 * 1000, // 23 hours
  weekly: (6.5 * 24 * 60 * 60 * 1000), // 6.5 days
};

export async function listDueGovernanceJobs(
  options: ListDueGovernanceJobsOptions = {},
): Promise<GovernanceJob[]> {
  await ensureGovernanceJobStore();
  const allActive = await listGovernanceJobs({
    status: 'active',
    tenantId: options.tenantId,
    projectId: options.projectId,
  });

  const now = options.now ?? new Date();

  return allActive.filter(job => {
    if (options.jobTypes && !options.jobTypes.includes(job.jobType)) return false;
    if (job.cadence === 'manual') return false;
    if (!job.lastRunAt) return true; // never run = due

    const elapsed = now.getTime() - new Date(job.lastRunAt).getTime();
    const threshold = CADENCE_THRESHOLDS[job.cadence] ?? Infinity;
    return elapsed >= threshold;
  });
}

// ── Seed ─────────────────────────────────────────────────

const SEED_JOBS: CreateGovernanceJobInput[] = [
  {
    jobType: 'consistency_audit',
    cadence: 'daily',
    dedupeKey: 'gov-job-consistency-audit',
  },
  {
    jobType: 'hotspot',
    cadence: 'daily',
    dedupeKey: 'gov-job-hotspot',
  },
  {
    jobType: 'architecture_drift',
    cadence: 'weekly',
    dedupeKey: 'gov-job-architecture-drift',
  },
];

export async function seedGovernanceJobs(opts?: {
  tenantId?: string;
  projectId?: string;
}): Promise<GovernanceJob[]> {
  await ensureGovernanceJobStore();
  const results: GovernanceJob[] = [];

  for (const seed of SEED_JOBS) {
    const existing = await listGovernanceJobs({ jobType: seed.jobType, status: 'active' });
    if (existing.length > 0) {
      results.push(...existing);
      continue;
    }
    try {
      const job = await createGovernanceJob({
        ...seed,
        tenantId: opts?.tenantId,
        projectId: opts?.projectId,
      });
      results.push(job);
    } catch (err) {
      log.warn(`Failed to seed governance job "${seed.dedupeKey}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return results;
}

// ── Sweeper ──────────────────────────────────────────────

export async function runGovernanceSweep(opts?: {
  jobTypes?: GovernanceJobType[];
  dryRun?: boolean;
  tenantId?: string;
  projectId?: string;
  now?: Date;
}): Promise<GovernanceSweepResult> {
  const dryRun = opts?.dryRun !== false;
  await ensureGovernanceJobStore();

  const dueJobs = await listDueGovernanceJobs({
    jobTypes: opts?.jobTypes,
    tenantId: opts?.tenantId,
    projectId: opts?.projectId,
    now: opts?.now,
  });

  if (dueJobs.length === 0) {
    return { dryRun, jobsRun: 0, jobsSkipped: 0, findingsCreated: 0, errors: [], results: [] };
  }

  const results: GovernanceSweepJobResult[] = [];
  const errors: string[] = [];
  let findingsCreated = 0;

  for (const job of dueJobs) {
    const started = Date.now();
    try {
      const summary = await runJobAudit(job, dryRun);
      results.push({
        jobId: job.id,
        jobType: job.jobType,
        summary,
        durationMs: Date.now() - started,
      });

      if (!dryRun) {
        await updateGovernanceJob(job.id, {
          lastRunAt: new Date().toISOString(),
          resultSummary: summary,
        });
      }

      // Create todos for actionable findings (Phase 4.5.1 bridge)
      const created = await createTodosFromFindings(job, summary, dryRun);
      findingsCreated += created;
    } catch (err) {
      const msg = `${job.jobType} (${job.id}): ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      log.warn(`Sweep job failed: ${msg}`);
    }
  }

  return { dryRun, jobsRun: results.length, jobsSkipped: dueJobs.length - results.length, findingsCreated, errors, results };
}

async function runJobAudit(
  job: GovernanceJob,
  dryRun: boolean,
): Promise<Record<string, unknown>> {
  switch (job.jobType) {
    case 'consistency_audit':
      return runConsistencyAudit();
    case 'hotspot':
      return runHotspotAudit();
    case 'architecture_drift':
      return runArchitectureDriftAudit(job, dryRun);
    default:
      throw new Error(`Unknown job_type: ${job.jobType}`);
  }
}

async function runConsistencyAudit(): Promise<Record<string, unknown>> {
  const { reconcilePlanningTodosFromOpenDb } = await import('./governance-reconciliation.js');
  const { readStatusConstraintReportFromOpenDb } = await import('./governance-status-constraints.js');

  const [todoReport, statusReport] = await Promise.all([
    reconcilePlanningTodosFromOpenDb({ includeArchived: false }),
    readStatusConstraintReportFromOpenDb(),
  ]);

  return {
    auditedAt: new Date().toISOString(),
    todoReconciliation: {
      seedCount: todoReport.seedCount,
      dbCount: todoReport.dbCount,
      seedOnly: todoReport.seedOnly.length,
      dbOnly: todoReport.dbOnly.length,
      statusDrift: todoReport.statusDrift.length,
      items: todoReport.statusDrift.map(d => ({ id: d.id, title: d.title, expected: d.expectedStatus, actual: d.actualStatus })),
    },
    statusConstraints: {
      total: statusReport.constraints.length,
      validated: statusReport.constraints.filter(c => c.validated).length,
      unvalidated: statusReport.constraints.filter(c => !c.validated).length,
      invalidRows: statusReport.constraints.reduce((sum, c) => sum + c.invalidRowCount, 0),
    },
  };
}

async function runHotspotAudit(): Promise<Record<string, unknown>> {
  const { detectRuntimeCleanupFromOpenDb } = await import('./governance-runtime-cleanup.js');

  const cleanupReport = await detectRuntimeCleanupFromOpenDb();

  // Cross-reference with recent session_events for error frequency patterns
  const db = getDb();
  const errorPatternRows = await db.query<{ error_count: string }>(
    `SELECT COUNT(*)::text AS error_count
     FROM session_events
     WHERE type = 'error'
       AND created_at > now() - INTERVAL '24 hours'`,
  );

  return {
    auditedAt: new Date().toISOString(),
    runtimeCleanup: {
      taskRunsScanned: cleanupReport.taskRuns.scanned,
      illegalStatusCount: cleanupReport.taskRuns.illegalStatus.length,
      staleFixtureCount: cleanupReport.taskRuns.staleFixtureCandidates.length,
      runSpecsScanned: cleanupReport.runSpecs.scanned,
    },
    errorFrequency: {
      recentErrors24h: Number(errorPatternRows.rows[0]?.error_count ?? 0),
    },
  };
}

async function runArchitectureDriftAudit(
  job: GovernanceJob,
  dryRun: boolean,
): Promise<Record<string, unknown>> {
  const { buildExecutionStaticGraph } = await import('./execution-static-graph.js');
  const { getLatestBaseline, captureStaticGraphBaseline, diffBaselines, summarizeBaselineDiff } =
    await import('./static-graph-baselines.js');

  const graph = buildExecutionStaticGraph({ workspaceRoot: process.cwd() });
  const previous = await getLatestBaseline({
    tenantId: job.tenantId,
    projectId: job.projectId,
  });

  const baselineResult: Record<string, unknown> = {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    nodeKinds: [...new Set(graph.nodes.map(n => n.kind))],
    edgeKinds: [...new Set(graph.edges.map(e => e.kind))],
  };

  if (previous) {
    const diff = diffBaselines(graph, previous.graph);
    const { hasChanges, summary } = summarizeBaselineDiff(diff);
    baselineResult.previousBaselineId = previous.id;
    baselineResult.previousCapturedAt = previous.capturedAt;
    baselineResult.diff = diff;
    baselineResult.diffSummary = summary;
    baselineResult.hasStructuralChanges = hasChanges;

    // Rule effectiveness: check if the execution graph still reflects
    // patterns captured in active procedural rules from compactions.
    try {
      baselineResult.ruleEffectiveness = await checkRuleEffectiveness(graph);
    } catch (err) {
      log.warn(`Rule effectiveness check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    baselineResult.isFirstBaseline = true;
  }

  // Always capture a new baseline for next comparison
  if (!dryRun) {
    try {
      await captureStaticGraphBaseline({
        graph,
        label: `sweep-${job.id}`,
        capturedBy: 'governance_sweep',
        tenantId: job.tenantId,
        projectId: job.projectId,
      });
      baselineResult.newBaselineCaptured = true;
    } catch (err) {
      log.warn(`Failed to capture baseline: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    auditedAt: new Date().toISOString(),
    ...baselineResult,
  };
}

/**
 * Check whether active procedural rules from compactions are reflected
 * in the current execution graph. A rule is "matched" if its name or
 * content keywords appear in graph node labels, edge labels, or node ids.
 */
async function checkRuleEffectiveness(
  graph: { nodes: Array<{ id: string; kind: string; label: string }>; edges: Array<{ from: string; to: string; kind: string }>; warnings: string[] },
): Promise<Record<string, unknown>> {
  // Query the procedural_candidates table directly (same DB, no cross-package import)
  const db = getDb();
  let activeRules: Array<{ name: string; content: string; severity: string }> = [];
  try {
    await db.exec(`CREATE TABLE IF NOT EXISTS procedural_candidates (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT, severity TEXT, status TEXT
    )`);
    const rows = await db.query<{ name: string; content: string; severity: string }>(
      `SELECT name, content, severity FROM procedural_candidates WHERE status = 'active'`,
    );
    activeRules = rows.rows;
  } catch {
    return { checked: false, reason: 'procedural_candidates table not available' };
  }

  if (activeRules.length === 0) {
    return { checked: true, totalRules: 0, matchedRules: 0, unmatchedRules: [] };
  }

  const nodeLabels = graph.nodes.map(n => `${n.id} ${n.label}`).join(' ').toLowerCase();
  const edgeLabels = graph.edges.map(e => `${e.from} ${e.to} ${e.kind}`).join(' ').toLowerCase();

  const matched: string[] = [];
  const unmatched: string[] = [];

  for (const rule of activeRules) {
    const text = `${rule.name} ${rule.content}`.toLowerCase();
    // Check if any significant word from the rule appears in the graph
    const words = text.split(/\s+/).filter(w => w.length > 3);
    const matchCount = words.filter(w => nodeLabels.includes(w) || edgeLabels.includes(w)).length;
    const threshold = Math.max(1, Math.floor(words.length * 0.3));
    if (matchCount >= threshold) {
      matched.push(rule.name);
    } else {
      unmatched.push(rule.name);
    }
  }

  return {
    checked: true,
    totalRules: activeRules.length,
    matchedRules: matched.length,
    unmatchedRules: unmatched,
    unmatchedRuleNames: unmatched,
  };
}

async function createTodosFromFindings(
  job: GovernanceJob,
  summary: Record<string, unknown>,
  dryRun: boolean,
): Promise<number> {
  if (dryRun) return 0;

  let created = 0;
  try {
    const { createTodo } = await import('./todos.js');

    if (job.jobType === 'consistency_audit') {
      const todoRecon = summary.todoReconciliation as Record<string, unknown> | undefined;
      if (todoRecon && typeof todoRecon.seedOnly === 'number' && todoRecon.seedOnly > 0) {
        await createTodo({
          title: `Governance: ${todoRecon.seedOnly} seed-only todos detected`,
          description: `Consistency audit found ${todoRecon.seedOnly} todos defined in seeds but missing from DB, and ${todoRecon.dbOnly ?? 0} DB-only todos. Review the full report at ${job.id}.`,
          kind: 'task',
          status: 'backlog',
          priority: 'P1',
          source: 'governance_sweep',
          metadata: { sweepJobId: job.id, sweepJobType: job.jobType, auditType: 'seedOnly' },
        });
        created += 1;
      }
      if (todoRecon && typeof todoRecon.statusDrift === 'number' && todoRecon.statusDrift > 0) {
        await createTodo({
          title: `Governance: ${todoRecon.statusDrift} status drift(s) detected`,
          description: `Consistency audit found ${todoRecon.statusDrift} todo status mismatches between seeds and DB. Review the full report at ${job.id}.`,
          kind: 'task',
          status: 'backlog',
          priority: 'P1',
          source: 'governance_sweep',
          metadata: { sweepJobId: job.id, sweepJobType: job.jobType, auditType: 'statusDrift' },
        });
        created += 1;
      }
    }

    if (job.jobType === 'hotspot') {
      const cleanup = summary.runtimeCleanup as Record<string, unknown> | undefined;
      if (cleanup && typeof cleanup.illegalStatusCount === 'number' && cleanup.illegalStatusCount > 0) {
        await createTodo({
          title: `Governance: ${cleanup.illegalStatusCount} task runs with illegal status`,
          description: `Hotspot audit found ${cleanup.illegalStatusCount} illegal status task runs and ${cleanup.staleFixtureCount ?? 0} stale fixtures. Review the full report at ${job.id}.`,
          kind: 'task',
          status: 'backlog',
          priority: 'P1',
          source: 'governance_sweep',
          metadata: { sweepJobId: job.id, sweepJobType: job.jobType, auditType: 'illegalStatus' },
        });
        created += 1;
      }
    }

    if (job.jobType === 'architecture_drift') {
      // Always create a checkpoint todo for architecture drift audits
      await createTodo({
        title: `Governance: Architecture graph audit — ${summary.nodeCount ?? 0} nodes, ${summary.edgeCount ?? 0} edges`,
        description: `Architecture drift audit captured the current execution graph. Compare with previous baseline. Review at ${job.id}.`,
        kind: 'task',
        status: 'backlog',
        priority: 'P2',
        source: 'governance_sweep',
        metadata: { sweepJobId: job.id, sweepJobType: job.jobType, auditType: 'baseline' },
      });
      created += 1;
    }
  } catch (err) {
    log.warn(`Failed to create findings todo for ${job.jobType}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return created;
}

// ── Helpers ──────────────────────────────────────────────

type GovernanceJobRow = {
  id: string;
  job_type: string;
  cadence: string;
  status: string;
  config_json: unknown;
  last_run_at: Date | string | null;
  last_task_run_id: string | null;
  result_summary_json: unknown;
  dedupe_key: string | null;
  tenant_id: string | null;
  project_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function rowToJob(row: GovernanceJobRow): GovernanceJob {
  return {
    id: row.id,
    jobType: normalizeJobType(row.job_type),
    cadence: normalizeCadence(row.cadence),
    status: normalizeJobStatus(row.status),
    config: normalizeJsonObject(row.config_json),
    lastRunAt: row.last_run_at ? toIsoString(row.last_run_at) : undefined,
    lastTaskRunId: row.last_task_run_id ?? undefined,
    resultSummary: row.result_summary_json
      ? normalizeJsonObject(row.result_summary_json)
      : undefined,
    dedupeKey: row.dedupe_key ?? undefined,
    tenantId: row.tenant_id ?? undefined,
    projectId: row.project_id ?? undefined,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function normalizeJobType(value: string): GovernanceJobType {
  const valid: GovernanceJobType[] = ['consistency_audit', 'hotspot', 'architecture_drift'];
  return valid.includes(value as GovernanceJobType) ? (value as GovernanceJobType) : 'consistency_audit';
}

function normalizeCadence(value: string): GovernanceCadence {
  const valid: GovernanceCadence[] = ['manual', 'hourly', 'daily', 'weekly'];
  return valid.includes(value as GovernanceCadence) ? (value as GovernanceCadence) : 'manual';
}

function normalizeJobStatus(value: string): GovernanceJobStatus {
  const valid: GovernanceJobStatus[] = ['active', 'paused', 'retired'];
  return valid.includes(value as GovernanceJobStatus) ? (value as GovernanceJobStatus) : 'active';
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { return {}; }
  }
  return {};
}

function normalizeLimit(value: unknown): number {
  const parsed = Number(value ?? 100);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.max(1, Math.min(1000, Math.floor(parsed)));
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('governance_jobs write returned no row');
  return row;
}
