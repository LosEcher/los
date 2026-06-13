-- 003_session_events: append-only event ledger
CREATE TABLE IF NOT EXISTS session_events (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  tenant_id TEXT,
  project_id TEXT,
  user_id TEXT,
  node_id TEXT,
  request_id TEXT,
  trace_id TEXT,
  "type" TEXT NOT NULL,
  turn INTEGER NOT NULL DEFAULT 0,
  "source" TEXT,
  model TEXT,
  tool_name TEXT,
  visibility TEXT NOT NULL DEFAULT 'public',
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events (session_id, id);
CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events (session_id, "type");
