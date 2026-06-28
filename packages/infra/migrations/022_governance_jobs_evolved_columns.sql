-- 022_governance_jobs_evolved_columns.sql
-- Canonicalize the evolved governance_jobs columns that the runtime
-- ensureGovernanceJobStore() SCHEMA adds (circuit breaker + scheduling),
-- so a fresh `db:migrate` produces the full table without relying on the
-- ensure*Store path. Idempotent: safe on fresh DBs and on tables already
-- upgraded by ensureGovernanceJobStore().
--
-- These columns previously lived only in
-- packages/agent/src/governance-jobs-schema.ts (SCHEMA), which meant a
-- dropped-and-recreated table could not be restored by re-running
-- migrations 007/009 alone — the gateway sweep loop would then fail on
-- the missing next_run_at column. This migration closes that gap.

ALTER TABLE governance_jobs ADD COLUMN IF NOT EXISTS auto_fix_config_json JSONB;
ALTER TABLE governance_jobs ADD COLUMN IF NOT EXISTS consecutive_no_ops INTEGER NOT NULL DEFAULT 0;
ALTER TABLE governance_jobs ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE governance_jobs ADD COLUMN IF NOT EXISTS circuit_state TEXT NOT NULL DEFAULT 'closed';
ALTER TABLE governance_jobs ADD COLUMN IF NOT EXISTS circuit_opened_at TIMESTAMPTZ;
ALTER TABLE governance_jobs ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ;

DO $$
BEGIN
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

-- Index for the claimNextDueJob() query (status = 'active' AND next_run_at <= now())
CREATE INDEX IF NOT EXISTS idx_gov_jobs_next_run
  ON governance_jobs(next_run_at, status)
  WHERE next_run_at IS NOT NULL;
