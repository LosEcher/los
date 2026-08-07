-- 050_run_specs_parent.sql
-- Align run_specs with ensureRunSpecStore: parent_run_spec_id column + index
-- were created by the runtime ensure*Store but missing from migrations
-- (drift baseline: COLUMNS parent_run_spec_id + INDEXES idx_run_specs_parent).

ALTER TABLE run_specs ADD COLUMN IF NOT EXISTS parent_run_spec_id TEXT;
CREATE INDEX IF NOT EXISTS idx_run_specs_parent ON run_specs(parent_run_spec_id);
