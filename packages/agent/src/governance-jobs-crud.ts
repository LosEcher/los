import { randomUUID } from 'node:crypto';
import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import { ensureGovernanceJobStore, SEED_JOBS } from './governance-jobs-schema.js';
import { normalizeLimit, assertRow, rowToJob } from './governance-jobs-normalizers.js';
import type {
  GovernanceJob,
  GovernanceJobRow,
  GovernanceJobType,
  CreateGovernanceJobInput,
  UpdateGovernanceJobInput,
  UpdateGovernanceJobStateInput,
  ListGovernanceJobsOptions,
  ListDueGovernanceJobsOptions,
} from './governance-jobs-types.js';
import { CADENCE_THRESHOLDS } from './governance-jobs-types.js';

const log = getLogger('governance-jobs');

// ── CRUD ─────────────────────────────────────────────────

export async function createGovernanceJob(
  input: CreateGovernanceJobInput,
): Promise<GovernanceJob> {
  await ensureGovernanceJobStore();
  const db = getDb();
  const id = `govjob-${randomUUID()}`;

  // Compute initial next_run_at: now() + stagger offset (default 0 = immediately due)
  const staggerMs = typeof input.initialStaggerMs === 'number' && input.initialStaggerMs > 0
    ? input.initialStaggerMs
    : 0;

  const rows = await db.query<GovernanceJobRow>(
    `INSERT INTO governance_jobs (
      id, job_type, cadence, status, config_json, auto_fix_config_json, dedupe_key, tenant_id, project_id, next_run_at
    ) VALUES ($1, $2, $3, $4, $5::jsonb, $9::jsonb, $6, $7, $8, now() + ($10 || ' milliseconds')::interval)
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
      input.autoFix ? JSON.stringify(input.autoFix) : null,
      String(staggerMs),
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
  if (input.autoFix !== undefined) {
    params.push(JSON.stringify(input.autoFix));
    sets.push(`auto_fix_config_json = $${params.length}::jsonb`);
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
  if (input.nextRunAt !== undefined) {
    if (input.nextRunAt === null) {
      sets.push(`next_run_at = NULL`);
    } else {
      params.push(input.nextRunAt);
      sets.push(`next_run_at = $${params.length}::timestamptz`);
    }
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

// ── State update (throttle / circuit breaker) ────────────

export async function updateGovernanceJobState(
  id: string,
  state: UpdateGovernanceJobStateInput,
): Promise<GovernanceJob | null> {
  await ensureGovernanceJobStore();
  const existing = await getGovernanceJob(id);
  if (!existing) return null;

  const db = getDb();
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [id];

  if (state.consecutiveNoOps !== undefined) {
    params.push(state.consecutiveNoOps);
    sets.push(`consecutive_no_ops = $${params.length}`);
  }
  if (state.consecutiveFailures !== undefined) {
    params.push(state.consecutiveFailures);
    sets.push(`consecutive_failures = $${params.length}`);
  }
  if (state.circuitState !== undefined) {
    params.push(state.circuitState);
    sets.push(`circuit_state = $${params.length}`);
  }
  if (state.circuitOpenedAt !== undefined) {
    params.push(state.circuitOpenedAt);
    sets.push(`circuit_opened_at = $${params.length}::timestamptz`);
  }

  const rows = await db.query<GovernanceJobRow>(
    `UPDATE governance_jobs SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    params,
  );

  return rows.rows[0] ? rowToJob(rows.rows[0]) : null;
}

// ── Due Job Listing ──────────────────────────────────────

/**
 * Atomically claim the next due governance job using FOR UPDATE SKIP LOCKED.
 * Used by the PG-queue claim loop — safe across concurrent gateway processes.
 *
 * Pattern: single-CTE SELECT + UPDATE, matching file-sync's store-queue.ts:114.
 */
export async function claimNextDueJob(): Promise<GovernanceJob | null> {
  await ensureGovernanceJobStore();
  const db = getDb();

  const rows = await db.query<GovernanceJobRow>(
    `WITH selected AS (
      SELECT id FROM governance_jobs
      WHERE status = 'active'
        AND next_run_at <= now()
      ORDER BY next_run_at ASC, id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE governance_jobs SET
      next_run_at = NULL,
      updated_at = now()
    FROM selected
    WHERE governance_jobs.id = selected.id
    RETURNING governance_jobs.*`,
  );

  return rows.rows[0] ? rowToJob(rows.rows[0]) : null;
}

// ── Due Job Listing (traditional, for API / manual sweep) ──

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
    if (!job.lastRunAt) return true;

    const elapsed = now.getTime() - new Date(job.lastRunAt).getTime();
    const threshold = CADENCE_THRESHOLDS[job.cadence] ?? Infinity;
    return elapsed >= threshold;
  });
}

// ── Seed ─────────────────────────────────────────────────

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
