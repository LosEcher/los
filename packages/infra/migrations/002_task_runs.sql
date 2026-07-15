-- 002_task_runs: task execution records
-- Canonical schema mirrors ensureTaskRunStore (task-runs/schema.ts).
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
  prompt_preview TEXT NOT NULL DEFAULT '',
  tool_mode TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  lease_version BIGINT NOT NULL DEFAULT 0,
  lease_expires_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_active_dedupe ON task_runs(dedupe_key) WHERE dedupe_key IS NOT NULL AND status = ANY (ARRAY['queued', 'running']);
CREATE INDEX IF NOT EXISTS idx_task_runs_dedupe_key ON task_runs(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_task_runs_lease ON task_runs(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_task_runs_node_id ON task_runs(node_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_request_id ON task_runs(request_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_session_id ON task_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);
CREATE INDEX IF NOT EXISTS idx_task_runs_tenant_project ON task_runs(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_trace_id ON task_runs(trace_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_updated ON task_runs(updated_at DESC);
