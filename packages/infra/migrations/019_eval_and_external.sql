-- 019_eval_and_external.sql
-- run_evals, external_tool_summaries

CREATE TABLE IF NOT EXISTS run_evals (
  id TEXT PRIMARY KEY,
  run_spec_id TEXT,
  task_run_id TEXT,
  session_id TEXT,
  eval_case_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  passed BOOLEAN,
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_run_evals_case ON run_evals(eval_case_id);
CREATE INDEX IF NOT EXISTS idx_run_evals_status ON run_evals(status);

CREATE TABLE IF NOT EXISTS external_tool_summaries (
  id TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  source TEXT NOT NULL,
  session_id TEXT,
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_external_tool_summaries_tool ON external_tool_summaries(tool_name, source);
