-- 038_skill_mcp_distribution.sql
-- Auditable skill and MCP distribution versions, pins, auth/policy separation.

ALTER TABLE skills ADD COLUMN IF NOT EXISTS pinned_version_hash TEXT;

CREATE TABLE IF NOT EXISTS skill_versions (
  skill_id TEXT NOT NULL,
  version_hash TEXT NOT NULL,
  source_path TEXT NOT NULL DEFAULT '',
  snapshot_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, version_hash)
);
CREATE INDEX IF NOT EXISTS idx_skill_versions_created
  ON skill_versions(skill_id, created_at DESC);

ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS source_uri TEXT NOT NULL DEFAULT '';
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS version_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS pinned_version_hash TEXT;
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS auth_json JSONB NOT NULL DEFAULT '{"mode":"none"}'::jsonb;
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS tool_policy_json JSONB NOT NULL DEFAULT '{"allow":[],"deny":[],"riskLevel":"L1"}'::jsonb;
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS distribution_json JSONB NOT NULL DEFAULT '{}'::jsonb;

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
