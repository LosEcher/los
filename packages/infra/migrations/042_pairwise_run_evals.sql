-- Extend the canonical run_evals ledger with immutable pairwise rubric evidence.
-- Existing single-run eval rows retain their current semantics.

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

CREATE INDEX IF NOT EXISTS idx_run_evals_pair_id
  ON run_evals(pair_id) WHERE evaluation_kind = 'pairwise';
CREATE INDEX IF NOT EXISTS idx_run_evals_experiment
  ON run_evals(experiment_id, created_at DESC) WHERE evaluation_kind = 'pairwise';
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_evals_pair_identity
  ON run_evals(experiment_id, baseline_run_spec_id, candidate_run_spec_id, rubric_revision)
  WHERE evaluation_kind = 'pairwise';
