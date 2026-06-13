-- 001_sessions: session store
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  project_id TEXT,
  user_id TEXT,
  request_id TEXT,
  trace_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  messages JSONB NOT NULL DEFAULT '[]',
  turns JSONB NOT NULL DEFAULT '[]',
  metadata JSONB NOT NULL DEFAULT '{}'
);
