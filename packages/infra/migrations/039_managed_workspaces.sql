-- 039_managed_workspaces.sql
-- Operator-managed jj workspaces and append-only lifecycle evidence.

CREATE TABLE IF NOT EXISTS managed_workspaces (
  workspace_id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  source_root TEXT NOT NULL,
  workspace_root TEXT NOT NULL UNIQUE,
  workspace_name TEXT NOT NULL UNIQUE,
  vcs_kind TEXT NOT NULL DEFAULT 'jj',
  base_revision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'creating',
  backup_artifact_id TEXT,
  created_by TEXT NOT NULL,
  last_error TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_managed_workspaces_graph
  ON managed_workspaces(graph_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_managed_workspaces_task
  ON managed_workspaces(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_managed_workspaces_project
  ON managed_workspaces(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS managed_workspace_events (
  event_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  artifact_id TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_managed_workspace_events_workspace
  ON managed_workspace_events(workspace_id, created_at ASC);
