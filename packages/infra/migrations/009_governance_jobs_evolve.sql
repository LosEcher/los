-- 009_governance_jobs_evolve.sql
-- Evolve governance_jobs table: add status column + updated constraints
-- for the rewritten governance-jobs.ts (which uses status instead of enabled).
-- 007_governance_jobs.sql is the canonical initial schema.
-- This migration is idempotent: safe to run on fresh DBs and upgraded DBs.

-- Add status column (replaces enabled boolean with richer state model)
ALTER TABLE governance_jobs ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

-- Data migration: map enabled=false rows to status='paused'
-- (enabled column does not exist in fresh 007 schema; guarded via
--  information_schema check to avoid migration noise on new installs)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'governance_jobs' AND column_name = 'enabled'
  ) THEN
    UPDATE governance_jobs SET status = 'paused' WHERE enabled = false AND status = 'active';
  END IF;
END $$;

-- Add status check constraint
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
END $$;

-- Replace cadence check constraint to include 'hourly' (Postgres can't ALTER a CHECK constraint)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'governance_jobs_cadence_chk'
      AND conrelid = 'governance_jobs'::regclass
  ) THEN
    ALTER TABLE governance_jobs DROP CONSTRAINT governance_jobs_cadence_chk;
  END IF;
END $$;

ALTER TABLE governance_jobs
  ADD CONSTRAINT governance_jobs_cadence_chk
  CHECK (cadence IN ('manual', 'hourly', 'daily', 'weekly'));

-- Add new indexes for sweep query patterns
CREATE INDEX IF NOT EXISTS idx_gov_jobs_type_status ON governance_jobs(job_type, status);
CREATE INDEX IF NOT EXISTS idx_gov_jobs_cadence_last_run ON governance_jobs(cadence, last_run_at);
