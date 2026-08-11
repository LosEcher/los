-- 054: Controlled Operator Language snapshots + monthly governance cadence
-- Aligns migrateDir schema with ensure*Store SCHEMA for:
--   1) governance_jobs.cadence CHECK includes 'monthly'
--   2) language_contract_snapshots table for weekly/monthly language audits

-- Widen cadence check (Postgres cannot ALTER a CHECK constraint in place).
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
  CHECK (cadence IN ('manual', 'hourly', 'daily', 'weekly', 'monthly'));

CREATE TABLE IF NOT EXISTS language_contract_snapshots (
  id TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  finding_count INTEGER NOT NULL DEFAULT 0,
  findings_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  cadence_recommendation TEXT,
  contract_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_language_contract_snapshots_created
  ON language_contract_snapshots(created_at DESC);
