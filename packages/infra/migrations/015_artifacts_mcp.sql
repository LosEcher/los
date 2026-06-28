-- 015_artifacts_mcp.sql
-- artifacts (base table), mcp_servers

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  session_id TEXT,
  task_run_id TEXT,
  trace_id TEXT,
  request_id TEXT,
  workspace_root TEXT,
  original_path TEXT,
  path_policy TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  checksum TEXT NOT NULL,
  checksum_algorithm TEXT NOT NULL DEFAULT 'sha256',
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  status TEXT NOT NULL DEFAULT 'draft',
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_artifacts_node_id ON artifacts(node_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_session_id ON artifacts(session_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_task_run_id ON artifacts(task_run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_trace_id ON artifacts(trace_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_deleted ON artifacts(deleted_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_status ON artifacts(status);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  transport TEXT NOT NULL DEFAULT 'stdio',
  command TEXT,
  args_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  url TEXT,
  env_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'unverified',
  last_error TEXT,
  tool_count INTEGER NOT NULL DEFAULT 0,
  tools_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, tenant_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_tenant_project ON mcp_servers(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_mcp_servers_status ON mcp_servers(status);
