export const _MCP_SERVER_SCHEMA = `
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  transport TEXT NOT NULL DEFAULT 'stdio',
  command TEXT,
  args_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  url TEXT,
  env_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'unverified',
  last_error TEXT,
  tool_count INTEGER NOT NULL DEFAULT 0,
  tools_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_uri TEXT NOT NULL DEFAULT '',
  version_hash TEXT NOT NULL DEFAULT '',
  pinned_version_hash TEXT,
  auth_json JSONB NOT NULL DEFAULT '{"mode":"none"}'::jsonb,
  tool_policy_json JSONB NOT NULL DEFAULT '{"allow":[],"deny":[],"riskLevel":"L1"}'::jsonb,
  distribution_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, tenant_id, project_id)
);
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS source_uri TEXT NOT NULL DEFAULT '';
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS version_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS pinned_version_hash TEXT;
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS auth_json JSONB NOT NULL DEFAULT '{"mode":"none"}'::jsonb;
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS tool_policy_json JSONB NOT NULL DEFAULT '{"allow":[],"deny":[],"riskLevel":"L1"}'::jsonb;
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS distribution_json JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_mcp_servers_tenant_project
  ON mcp_servers(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled
  ON mcp_servers(enabled) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_mcp_servers_status
  ON mcp_servers(status);
CREATE TABLE IF NOT EXISTS mcp_server_versions (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  version_hash TEXT NOT NULL,
  snapshot_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, tenant_id, project_id, version_hash)
);
CREATE INDEX IF NOT EXISTS idx_mcp_server_versions_created
  ON mcp_server_versions(id, tenant_id, project_id, created_at DESC);
`;
