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
  evaluation_kind TEXT NOT NULL DEFAULT 'single',
  pair_id TEXT,
  experiment_id TEXT,
  baseline_run_spec_id TEXT,
  candidate_run_spec_id TEXT,
  rubric_revision TEXT,
  rubric_snapshot_json JSONB,
  human_evidence_json JSONB,
  judge_evidence_json JSONB,
  deterministic_evidence_json JSONB,
  pairwise_verdict TEXT,
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE run_evals ADD COLUMN IF NOT EXISTS failover_scope TEXT;
ALTER TABLE run_evals ADD COLUMN IF NOT EXISTS evaluation_kind TEXT NOT NULL DEFAULT 'single';
ALTER TABLE run_evals ADD COLUMN IF NOT EXISTS pair_id TEXT;
ALTER TABLE run_evals ADD COLUMN IF NOT EXISTS experiment_id TEXT;
ALTER TABLE run_evals ADD COLUMN IF NOT EXISTS baseline_run_spec_id TEXT;
ALTER TABLE run_evals ADD COLUMN IF NOT EXISTS candidate_run_spec_id TEXT;
ALTER TABLE run_evals ADD COLUMN IF NOT EXISTS rubric_revision TEXT;
ALTER TABLE run_evals ADD COLUMN IF NOT EXISTS rubric_snapshot_json JSONB;
ALTER TABLE run_evals ADD COLUMN IF NOT EXISTS human_evidence_json JSONB;
ALTER TABLE run_evals ADD COLUMN IF NOT EXISTS judge_evidence_json JSONB;
ALTER TABLE run_evals ADD COLUMN IF NOT EXISTS deterministic_evidence_json JSONB;
ALTER TABLE run_evals ADD COLUMN IF NOT EXISTS pairwise_verdict TEXT;

CREATE INDEX IF NOT EXISTS idx_run_evals_run_spec ON run_evals(run_spec_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_session ON run_evals(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_task_run ON run_evals(task_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_provider_model ON run_evals(provider, model, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_success ON run_evals(success, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_failure_class ON run_evals(failure_class, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_failover_scope ON run_evals(failover_scope, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_verification ON run_evals(verification_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_pair_id ON run_evals(pair_id) WHERE evaluation_kind = 'pairwise';
CREATE INDEX IF NOT EXISTS idx_run_evals_experiment ON run_evals(experiment_id, created_at DESC) WHERE evaluation_kind = 'pairwise';
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_evals_pair_identity
  ON run_evals(experiment_id, baseline_run_spec_id, candidate_run_spec_id, rubric_revision)
  WHERE evaluation_kind = 'pairwise';
`;
