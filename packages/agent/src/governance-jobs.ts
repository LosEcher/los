import { randomUUID } from 'node:crypto';
import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import type { StaticAnalysisScanResult } from '@los/agent';

const log = getLogger('governance-jobs');

export type GovernanceJobType =
  | 'consistency_audit'
  | 'hotspot'
  | 'architecture_drift'
  | 'tool_drift'
  | 'provider_surveillance';

export type GovernanceCadence = 'daily' | 'weekly' | 'release_gate' | 'manual';

export interface GovernanceJobRecord {
  id: string;
  jobType: GovernanceJobType;
  cadence: GovernanceCadence;
  tenantId?: string;
  projectId?: string;
  config: Record<string, unknown>;
  enabled: boolean;
  lastRunAt?: string;
  lastTaskRunId?: string;
  resultSummary?: GovernanceResultSummary;
  dedupeKey?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GovernanceResultSummary {
  status: 'pass' | 'fail' | 'action_required';
  counts: Record<string, number>;
  findings?: number;
  errors?: string[];
  taskRunId?: string;
  runAt?: string;
}

export interface UpsertGovernanceJobInput {
  id?: string;
  jobType: GovernanceJobType;
  cadence: GovernanceCadence;
  tenantId?: string;
  projectId?: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS governance_jobs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  cadence TEXT NOT NULL DEFAULT 'manual',
  tenant_id TEXT,
  project_id TEXT,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  last_task_run_id TEXT,
  result_summary_json JSONB,
  dedupe_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

let _initialized = false;

export async function ensureGovernanceJobStore(): Promise<void> {
  if (_initialized) return;
  await getDb().exec(SCHEMA);
  _initialized = true;
  log.info('Governance job store initialized');
}

export async function upsertGovernanceJob(
  input: UpsertGovernanceJobInput,
): Promise<GovernanceJobRecord> {
  await ensureGovernanceJobStore();
  const db = getDb();
  const id = input.id ?? `govjob-${input.jobType}-${randomUUID().slice(0, 12)}`;
  const config = input.config ?? {};

  const rows = await db.query<GovernanceJobRow>(
    `INSERT INTO governance_jobs (id, job_type, cadence, tenant_id, project_id, config_json, enabled)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (id) DO UPDATE SET
       cadence = $3, config_json = $6::jsonb, enabled = $7, updated_at = now()
     RETURNING *`,
    [id, input.jobType, input.cadence, input.tenantId ?? null, input.projectId ?? null,
     JSON.stringify(config), input.enabled ?? true],
  );
  return rowToJob(rows.rows[0]!);
}

export async function listDueGovernanceJobs(
  options: { now?: Date; jobType?: GovernanceJobType } = {},
): Promise<GovernanceJobRecord[]> {
  await ensureGovernanceJobStore();
  const db = getDb();
  const now = options.now ?? new Date();
  const params: unknown[] = [];

  // Filter to enabled jobs where the cadence window has passed
  const clauses = ['enabled = true'];

  // Cadence gating: manual jobs always return, others check last_run_at gap
  clauses.push(`(
    cadence = 'manual'
    OR last_run_at IS NULL
    OR (cadence = 'daily' AND last_run_at < $1::timestamptz - interval '23 hours')
    OR (cadence = 'weekly' AND last_run_at < $1::timestamptz - interval '6 days')
    OR (cadence = 'release_gate' AND last_run_at IS NULL)
  )`);
  params.push(now.toISOString());

  if (options.jobType) {
    params.push(options.jobType);
    clauses.push(`job_type = $${params.length}`);
  }

  const rows = await db.query<GovernanceJobRow>(
    `SELECT * FROM governance_jobs WHERE ${clauses.join(' AND ')} ORDER BY last_run_at ASC NULLS FIRST`,
    params,
  );
  return rows.rows.map(rowToJob);
}

export async function recordGovernanceJobRun(
  id: string,
  taskRunId: string,
  summary: GovernanceResultSummary,
): Promise<GovernanceJobRecord | null> {
  await ensureGovernanceJobStore();
  const db = getDb();
  const rows = await db.query<GovernanceJobRow>(
    `UPDATE governance_jobs SET
       last_run_at = now(),
       last_task_run_id = $2,
       result_summary_json = $3::jsonb,
       updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, taskRunId, JSON.stringify({ ...summary, taskRunId, runAt: new Date().toISOString() })],
  );
  if (!rows.rows[0]) return null;
  return rowToJob(rows.rows[0]);
}

export async function loadGovernanceJob(id: string): Promise<GovernanceJobRecord | null> {
  await ensureGovernanceJobStore();
  const rows = await getDb().query<GovernanceJobRow>(
    'SELECT * FROM governance_jobs WHERE id = $1', [id],
  );
  return rows.rows[0] ? rowToJob(rows.rows[0]) : null;
}

export async function listGovernanceJobs(
  options: { jobType?: GovernanceJobType; enabled?: boolean; limit?: number } = {},
): Promise<GovernanceJobRecord[]> {
  await ensureGovernanceJobStore();
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.jobType) {
    params.push(options.jobType);
    clauses.push(`job_type = $${params.length}`);
  }
  if (options.enabled !== undefined) {
    params.push(options.enabled);
    clauses.push(`enabled = $${params.length}`);
  }
  const limit = Math.max(1, Math.min(100, options.limit ?? 50));
  params.push(limit);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = await db.query<GovernanceJobRow>(
    `SELECT * FROM governance_jobs ${where} ORDER BY updated_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(rowToJob);
}

/**
 * Seed the standard set of governance jobs. Safe to call multiple times
 * (uses upsert so existing jobs are not duplicated).
 */
export async function seedGovernanceJobs(): Promise<GovernanceJobRecord[]> {
  await ensureGovernanceJobStore();

  const defaults: Array<{ id: string; jobType: GovernanceJobType; cadence: GovernanceCadence; config: Record<string, unknown> }> = [
    {
      id: 'govjob-consistency-daily',
      jobType: 'consistency_audit',
      cadence: 'daily',
      config: { scanTargets: ['packages/'], rules: ['los.state-machine-bypass', 'los.file-size-gate'] },
    },
    {
      id: 'govjob-hotspot-weekly',
      jobType: 'hotspot',
      cadence: 'weekly',
      config: { sizeThreshold: 400, changeWindowMs: 7 * 24 * 3600 * 1000 },
    },
    {
      id: 'govjob-arch-drift-weekly',
      jobType: 'architecture_drift',
      cadence: 'weekly',
      config: { scanTargets: ['packages/'], rules: ['los.direct-infra-import', 'los.no-package-local-agents'] },
    },
    {
      id: 'govjob-provider-surveillance-daily',
      jobType: 'provider_surveillance',
      cadence: 'daily',
      config: { compatTargets: ['deepseek', 'openai', 'anthropic'] },
    },
  ];

  const results: GovernanceJobRecord[] = [];
  for (const job of defaults) {
    results.push(await upsertGovernanceJob(job));
  }
  return results;
}

// ── Internal row types and mappers ──

type GovernanceJobRow = {
  id: string;
  job_type: string;
  cadence: string;
  tenant_id: string | null;
  project_id: string | null;
  config_json: unknown;
  enabled: boolean;
  last_run_at: string | null;
  last_task_run_id: string | null;
  result_summary_json: unknown;
  dedupe_key: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function rowToJob(row: GovernanceJobRow): GovernanceJobRecord {
  return {
    id: row.id,
    jobType: row.job_type as GovernanceJobType,
    cadence: row.cadence as GovernanceCadence,
    tenantId: row.tenant_id ?? undefined,
    projectId: row.project_id ?? undefined,
    config: normalizeJson(row.config_json),
    enabled: row.enabled,
    lastRunAt: row.last_run_at ?? undefined,
    lastTaskRunId: row.last_task_run_id ?? undefined,
    resultSummary: row.result_summary_json
      ? (normalizeJson(row.result_summary_json) as unknown as GovernanceResultSummary)
      : undefined,
    dedupeKey: row.dedupe_key ?? undefined,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function normalizeJson(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
  }
  return {};
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
