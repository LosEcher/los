-- 002_task_runs: task execution records
CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_spec_id TEXT,
  trace_id TEXT,
  dedupe_key TEXT,
  tenant_id TEXT,
  project_id TEXT,
  user_id TEXT,
  node_id TEXT,
  request_id TEXT,
  prompt_preview TEXT,
  tool_mode TEXT,
  provider TEXT,
  model TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_task_runs_session ON task_runs (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs (status, completed_at);
CREATE INDEX IF NOT EXISTS idx_task_runs_dedupe ON task_runs (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');
