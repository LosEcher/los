export const RUN_EVAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS run_evals (
  id TEXT PRIMARY KEY,
  run_spec_id TEXT NOT NULL,
  session_id TEXT,
  task_run_id TEXT,
  provider TEXT,
  model TEXT,
  success BOOLEAN NOT NULL,
  latency_ms INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  tool_error_count INTEGER NOT NULL DEFAULT 0,
  verification_status TEXT NOT NULL DEFAULT 'unknown',
  model_cost NUMERIC,
  user_feedback TEXT,
  failure_class TEXT,
  failover_scope TEXT,
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE run_evals ADD COLUMN IF NOT EXISTS failover_scope TEXT;

CREATE INDEX IF NOT EXISTS idx_run_evals_run_spec ON run_evals(run_spec_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_session ON run_evals(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_task_run ON run_evals(task_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_provider_model ON run_evals(provider, model, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_success ON run_evals(success, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_failure_class ON run_evals(failure_class, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_failover_scope ON run_evals(failover_scope, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_verification ON run_evals(verification_status, created_at DESC);
`;
