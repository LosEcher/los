export const TASK_RUN_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  trace_id TEXT,
  dedupe_key TEXT,
  tenant_id TEXT,
  project_id TEXT,
  user_id TEXT,
  node_id TEXT,
  request_id TEXT,
  workspace_root TEXT NOT NULL,
  tool_mode TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  prompt_preview TEXT NOT NULL DEFAULT '',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ
);

ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS trace_id TEXT;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS node_id TEXT;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS run_spec_id TEXT;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS dispatch_id TEXT;

CREATE INDEX IF NOT EXISTS idx_task_runs_session_id ON task_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_trace_id ON task_runs(trace_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_dedupe_key ON task_runs(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_task_runs_tenant_project ON task_runs(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_node_id ON task_runs(node_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_request_id ON task_runs(request_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_lease ON task_runs(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);
CREATE INDEX IF NOT EXISTS idx_task_runs_updated ON task_runs(updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_active_dedupe
  ON task_runs(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'task_runs_status_chk'
      AND conrelid = 'task_runs'::regclass
  ) THEN
    ALTER TABLE task_runs
      ADD CONSTRAINT task_runs_status_chk
      CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'blocked'))
      NOT VALID;
  END IF;
END $$;
`;
