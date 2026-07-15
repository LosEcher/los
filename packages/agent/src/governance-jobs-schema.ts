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
  auto_fix_config_json JSONB,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  last_task_run_id TEXT,
  result_summary_json JSONB,
  dedupe_key TEXT,
  tenant_id TEXT,
  project_id TEXT,
  consecutive_no_ops INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  circuit_state TEXT NOT NULL DEFAULT 'closed',
  circuit_opened_at TIMESTAMPTZ,
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
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'governance_jobs_circuit_state_chk'
      AND conrelid = 'governance_jobs'::regclass
  ) THEN
    ALTER TABLE governance_jobs
      ADD CONSTRAINT governance_jobs_circuit_state_chk
      CHECK (circuit_state IN ('closed', 'half_open', 'open'));
  END IF;
END $$;

-- Migration: add columns if they don't exist (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'governance_jobs' AND column_name = 'auto_fix_config_json'
  ) THEN
    ALTER TABLE governance_jobs ADD COLUMN auto_fix_config_json JSONB;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'governance_jobs' AND column_name = 'consecutive_no_ops'
  ) THEN
    ALTER TABLE governance_jobs ADD COLUMN consecutive_no_ops INTEGER NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'governance_jobs' AND column_name = 'consecutive_failures'
  ) THEN
    ALTER TABLE governance_jobs ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'governance_jobs' AND column_name = 'circuit_state'
  ) THEN
    ALTER TABLE governance_jobs ADD COLUMN circuit_state TEXT NOT NULL DEFAULT 'closed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'governance_jobs' AND column_name = 'circuit_opened_at'
  ) THEN
    ALTER TABLE governance_jobs ADD COLUMN circuit_opened_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'governance_jobs' AND column_name = 'next_run_at'
  ) THEN
    ALTER TABLE governance_jobs ADD COLUMN next_run_at TIMESTAMPTZ;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_gov_jobs_dedupe
  ON governance_jobs(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status = 'active';

CREATE INDEX IF NOT EXISTS idx_gov_jobs_type_status ON governance_jobs(job_type, status);
CREATE INDEX IF NOT EXISTS idx_gov_jobs_cadence ON governance_jobs(cadence, last_run_at);
CREATE INDEX IF NOT EXISTS idx_gov_jobs_tenant_project ON governance_jobs(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_gov_jobs_next_run ON governance_jobs(next_run_at, status) WHERE next_run_at IS NOT NULL;
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
    initialStaggerMs: 0,
    autoFix: {
      autoFixEnabled: true,
      maxAutoFixAttempts: 3,
      verificationCommands: ['pnpm run _typecheck'],
      stopCondition: 'consecutive 2 sweeps with 0 seedOnly, 0 dbOnly, and 0 statusDrift',
      escalationCadence: 'after_retry',
    },
  },
  {
    jobType: 'hotspot',
    cadence: 'daily',
    dedupeKey: 'gov-job-hotspot',
    initialStaggerMs: 2 * 60 * 1000,
  },
  {
    jobType: 'architecture_drift',
    cadence: 'weekly',
    dedupeKey: 'gov-job-architecture-drift',
    initialStaggerMs: 5 * 60 * 1000,
  },
  {
    jobType: 'memory_integrity',
    cadence: 'daily',
    dedupeKey: 'gov-job-memory-integrity',
    initialStaggerMs: 10 * 60 * 1000,
  },
  {
    jobType: 'memory_retention',
    cadence: 'daily',
    dedupeKey: 'gov-job-memory-retention',
    initialStaggerMs: 15 * 60 * 1000,
  },
  {
    jobType: 'reflection',
    cadence: 'daily',
    dedupeKey: 'gov-job-reflection',
    initialStaggerMs: 20 * 60 * 1000,
  },
  {
    jobType: 'dead_letter',
    cadence: 'hourly',
    dedupeKey: 'gov-job-dead-letter',
    initialStaggerMs: 25 * 60 * 1000,
    config: { requeueLimit: 25 },
  },
  {
    jobType: 'branch_cleanup',
    cadence: 'hourly',
    dedupeKey: 'gov-job-branch-cleanup',
    initialStaggerMs: 30 * 60 * 1000,
    autoFix: {
      autoFixEnabled: true,
      maxAutoFixAttempts: 1,
      verificationCommands: [],
      stopCondition: 'no detached HEAD, optional mirror/main aligned with primary/main, and no stale primary branches classified as delete',
      escalationCadence: 'immediate',
    },
  },
  {
    jobType: 'related_project_scan',
    cadence: 'weekly',
    dedupeKey: 'gov-job-related-project-scan',
    initialStaggerMs: 60 * 60 * 1000,
    autoFix: {
      autoFixEnabled: false,
      maxAutoFixAttempts: 0,
      verificationCommands: [],
      stopCondition: 'scan completes successfully',
      escalationCadence: 'never',
    },
  },
  {
    jobType: 'file_size',
    cadence: 'daily',
    dedupeKey: 'gov-job-file-size',
    initialStaggerMs: 120 * 60 * 1000,
    autoFix: {
      autoFixEnabled: false,
      maxAutoFixAttempts: 0,
      verificationCommands: [],
      stopCondition: 'no files exceed 400 lines (all refactored or grandfathered)',
      escalationCadence: 'never',
    },
  },
  {
    jobType: 'supply_chain_audit',
    cadence: 'weekly',
    dedupeKey: 'gov-job-supply-chain',
    initialStaggerMs: 180 * 60 * 1000, // 3h stagger
  },
  {
    jobType: 'static_analysis',
    cadence: 'daily',
    dedupeKey: 'gov-job-static-analysis',
    initialStaggerMs: 4 * 60 * 1000, // 4min stagger — run early
  },
  {
    jobType: 'performance_audit',
    cadence: 'weekly',
    dedupeKey: 'gov-job-performance',
    initialStaggerMs: 6 * 60 * 1000, // 6min stagger
  },
  {
    jobType: 'event_retention',
    cadence: 'daily',
    dedupeKey: 'gov-job-event-retention',
    initialStaggerMs: 200 * 60 * 1000, // 3h20min — run late, after other daily jobs
    autoFix: {
      autoFixEnabled: true,
      maxAutoFixAttempts: 1,
      verificationCommands: [],
      stopCondition: 'no session_events older than 7 days remain uncompacted',
      escalationCadence: 'never',
    },
  },
  {
    jobType: 'code_topology_audit',
    cadence: 'weekly',
    dedupeKey: 'gov-job-code-topology',
    config: { targetRepo: '/Users/echerlos/syncthing/project/lot2extension/go-backend', projectName: 'lot2extension' },
    initialStaggerMs: 210 * 60 * 1000,
  },
];
