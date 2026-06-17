import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import type { CreateGovernanceJobInput } from './governance-jobs-types.js';

const log = getLogger('governance-jobs');

export const SCHEMA = `
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

export const SEED_JOBS: CreateGovernanceJobInput[] = [
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
  {
    jobType: 'memory_integrity',
    cadence: 'daily',
    dedupeKey: 'gov-job-memory-integrity',
  },
  {
    jobType: 'memory_retention',
    cadence: 'daily',
    dedupeKey: 'gov-job-memory-retention',
  },
  {
    jobType: 'reflection',
    cadence: 'daily',
    dedupeKey: 'gov-job-reflection',
  },
];
