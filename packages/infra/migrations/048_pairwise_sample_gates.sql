-- Operator-preregistered pairwise sample gates for the Execution Lab.
-- Registration is immutable: changing thresholds or scenarios requires
-- cancelling the gate and registering a new one. Evaluation counts real
-- pairwise evidence rows from run_evals (see run-evals/sample-gate.ts).

CREATE TABLE IF NOT EXISTS pairwise_sample_gates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  project_id TEXT,
  minimum_pairs INTEGER NOT NULL CHECK (minimum_pairs > 0),
  scenarios_json JSONB NOT NULL,
  baseline_ref_json JSONB NOT NULL,
  candidate_ref_json JSONB NOT NULL,
  rubric_ref_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'registered'
    CHECK (status IN ('registered', 'passed', 'superseded', 'cancelled')),
  registered_by TEXT NOT NULL,
  preregistered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  passed_at TIMESTAMPTZ,
  cancelled_by TEXT,
  cancelled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pairwise_sample_gates_scope_status
  ON pairwise_sample_gates(tenant_id, project_id, status);
