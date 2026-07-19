-- Immutable source provenance and explicit single-candidate experiment lifecycle.
CREATE TABLE IF NOT EXISTS execution_experiments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  project_id TEXT,
  source_session_id TEXT NOT NULL,
  source_run_spec_id TEXT NOT NULL,
  source_event_cursor BIGINT NOT NULL CHECK (source_event_cursor >= 0),
  source_evidence_hash TEXT NOT NULL,
  source_fingerprint_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  config_diff_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  candidate_run_spec_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by TEXT NOT NULL,
  approved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT execution_experiments_status_chk CHECK (status IN ('draft', 'approved', 'running', 'succeeded', 'failed', 'cancelled', 'blocked'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_experiments_candidate_run
  ON execution_experiments(candidate_run_spec_id) WHERE candidate_run_spec_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_execution_experiments_source
  ON execution_experiments(source_run_spec_id, source_event_cursor);
CREATE INDEX IF NOT EXISTS idx_execution_experiments_status
  ON execution_experiments(status, updated_at DESC);
