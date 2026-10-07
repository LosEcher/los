-- 061_governance_jobs_pause_source.sql
-- Provenance for a governance `pause`: an operator stop ('operator') must never
-- be auto-recovered, while a throttle/circuit stop is self-healing
-- (packages/agent/src/ga-circuit-breaker.ts, governance-sweeper.ts).
-- Created by ensure*Store (agent/src/governance-jobs-schema.ts SCHEMA); this
-- migration keeps the migrations-only path in agreement (check-migration-drift
-- gate). All statements are guarded so both paths converge idempotently.
ALTER TABLE governance_jobs ADD COLUMN IF NOT EXISTS pause_source TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'governance_jobs_pause_source_chk'
      AND conrelid = 'governance_jobs'::regclass
  ) THEN
    ALTER TABLE governance_jobs
      ADD CONSTRAINT governance_jobs_pause_source_chk
      CHECK (pause_source IS NULL OR pause_source IN ('operator', 'no_op_throttle', 'failure_threshold', 'circuit_open'));
  END IF;
END $$;
