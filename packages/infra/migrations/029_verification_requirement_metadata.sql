ALTER TABLE verification_records ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'command';
ALTER TABLE verification_records ADD COLUMN IF NOT EXISTS assertion TEXT;
ALTER TABLE verification_records ADD COLUMN IF NOT EXISTS reviewer TEXT;
ALTER TABLE verification_records ADD COLUMN IF NOT EXISTS plan_revision INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_verification_records_run_revision
  ON verification_records(run_spec_id, plan_revision, required);
