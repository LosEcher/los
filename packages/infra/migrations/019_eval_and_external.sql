-- 019_eval_and_external.sql
-- run_evals, external_tool_summaries
--
-- Canonical schema mirrors the runtime ensure*Store definitions in
-- packages/agent/src/run-evals/schema.ts (RUN_EVAL_SCHEMA) and
-- packages/agent/src/external-tool-summary.ts.
--
-- History: an earlier draft of this migration described a much smaller
-- run_evals (status/passed/metadata_json) and external_tool_summaries
-- (tool_name/source/provenance). That schema was never the runtime source
-- of truth — ensure*Store created the tables with the richer schema below.
-- This migration is rewritten to match the canonical ensure*Store schema
-- so a fresh `db:migrate` produces what the gateway actually expects.
-- Idempotent: safe on fresh DBs, on tables already created by ensure,
-- and on tables carrying orphaned legacy columns.

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

-- failover_scope is in CREATE TABLE above; this mirrors the ensure*Store
-- additive ALTER for DBs where the table pre-exists without the column.
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

CREATE INDEX IF NOT EXISTS idx_run_evals_run_spec
  ON run_evals(run_spec_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_session
  ON run_evals(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_task_run
  ON run_evals(task_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_provider_model
  ON run_evals(provider, model, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_success
  ON run_evals(success, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_failure_class
  ON run_evals(failure_class, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_failover_scope
  ON run_evals(failover_scope, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_verification
  ON run_evals(verification_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_evals_pair_id
  ON run_evals(pair_id) WHERE evaluation_kind = 'pairwise';
CREATE INDEX IF NOT EXISTS idx_run_evals_experiment
  ON run_evals(experiment_id, created_at DESC) WHERE evaluation_kind = 'pairwise';
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_evals_pair_identity
  ON run_evals(experiment_id, baseline_run_spec_id, candidate_run_spec_id, rubric_revision)
  WHERE evaluation_kind = 'pairwise';

-- Drop orphaned legacy column from the earlier migration draft
-- (eval_case_id). Unused by current code; rows carry only the default.
ALTER TABLE run_evals DROP COLUMN IF EXISTS eval_case_id;

CREATE TABLE IF NOT EXISTS external_tool_summaries (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  tool_version TEXT,
  source_kind TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  source_cwd TEXT,
  source_captured_at TIMESTAMPTZ,
  collected_at TIMESTAMPTZ NOT NULL,
  capture_policy TEXT NOT NULL,
  redaction_policy TEXT NOT NULL,
  imported_by TEXT,
  evidence_class TEXT NOT NULL DEFAULT 'external_summary',
  source_hash TEXT NOT NULL,
  summary_json JSONB NOT NULL,
  labels_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  redaction_status TEXT NOT NULL,
  redaction_replacements INTEGER NOT NULL DEFAULT 0,
  retention_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'external_tool_summaries_evidence_class_chk'
      AND conrelid = 'external_tool_summaries'::regclass
  ) THEN
    ALTER TABLE external_tool_summaries
      ADD CONSTRAINT external_tool_summaries_evidence_class_chk
      CHECK (evidence_class = 'external_summary');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_external_tool_summaries_tool
  ON external_tool_summaries(tool);
CREATE INDEX IF NOT EXISTS idx_external_tool_summaries_source
  ON external_tool_summaries(source_kind, source_ref);
CREATE INDEX IF NOT EXISTS idx_external_tool_summaries_hash
  ON external_tool_summaries(source_hash);
CREATE INDEX IF NOT EXISTS idx_external_tool_summaries_created
  ON external_tool_summaries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_external_tool_summaries_retention
  ON external_tool_summaries(retention_expires_at);
