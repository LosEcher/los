-- 001_sessions: session store
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  project_id TEXT,
  user_id TEXT,
  node_id TEXT,
  request_id TEXT,
  trace_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  messages_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  turns_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_sessions_request_id ON sessions(request_id);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant_project ON sessions(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_trace_id ON sessions(trace_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
