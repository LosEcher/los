-- 013_run_specs_verification.sql
-- Migrates run_specs, tool_call_states, verification_records from ensure*Store() DDL.
-- These three tables form the core execution state machine.

CREATE TABLE IF NOT EXISTS run_specs (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  tenant_id TEXT,
  project_id TEXT,
  user_id TEXT,
  node_id TEXT,
  request_id TEXT,
  trace_id TEXT,
  prompt TEXT NOT NULL DEFAULT '',
  provider TEXT,
  model TEXT,
  tool_mode TEXT NOT NULL DEFAULT 'project-write',
  status TEXT NOT NULL DEFAULT 'created',
  phase TEXT,
  run_contract_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT,
  dedupe_key TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_run_specs_status ON run_specs(status);
CREATE INDEX IF NOT EXISTS idx_run_specs_session ON run_specs(session_id);
CREATE INDEX IF NOT EXISTS idx_run_specs_tenant_project ON run_specs(tenant_id, project_id);

CREATE TABLE IF NOT EXISTS tool_call_states (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  run_spec_id TEXT,
  task_run_id TEXT,
  turn INTEGER NOT NULL DEFAULT 0,
  tool_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'requested',
  input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_summary TEXT,
  error TEXT,
  duration_ms INTEGER,
  attempt INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  idempotent BOOLEAN NOT NULL DEFAULT false,
  retry_policy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_tool_call_states_session ON tool_call_states(session_id, turn, id);
CREATE INDEX IF NOT EXISTS idx_tool_call_states_run_spec ON tool_call_states(run_spec_id);
CREATE INDEX IF NOT EXISTS idx_tool_call_states_task_run ON tool_call_states(task_run_id);
CREATE INDEX IF NOT EXISTS idx_tool_call_states_tool ON tool_call_states(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_call_states_state ON tool_call_states(state);

CREATE TABLE IF NOT EXISTS verification_records (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_spec_id TEXT,
  task_run_id TEXT,
  check_name TEXT NOT NULL,
  command TEXT,
  status TEXT NOT NULL DEFAULT 'required',
  required BOOLEAN NOT NULL DEFAULT true,
  skip_reason TEXT,
  output_summary TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_verification_records_session ON verification_records(session_id);
CREATE INDEX IF NOT EXISTS idx_verification_records_run_spec ON verification_records(run_spec_id);
CREATE INDEX IF NOT EXISTS idx_verification_records_task_run ON verification_records(task_run_id);
CREATE INDEX IF NOT EXISTS idx_verification_records_status ON verification_records(status);
