-- 003_session_events: append-only event ledger
-- Canonical schema mirrors ensureSessionEventStore (session-events.ts).
CREATE TABLE IF NOT EXISTS session_events (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  tenant_id TEXT,
  project_id TEXT,
  user_id TEXT,
  node_id TEXT,
  request_id TEXT,
  trace_id TEXT,
  "type" TEXT NOT NULL,
  turn INTEGER NOT NULL DEFAULT 0,
  "source" TEXT NOT NULL DEFAULT 'los',
  model TEXT,
  tool_name TEXT,
  visibility TEXT,
  cache_hit BOOLEAN,
  cache_key TEXT,
  parent_event_id BIGINT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  usage_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_session_events_cache_key ON session_events(cache_key);
CREATE INDEX IF NOT EXISTS idx_session_events_created ON session_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_events_model ON session_events(model);
CREATE INDEX IF NOT EXISTS idx_session_events_node_id ON session_events(node_id);
CREATE INDEX IF NOT EXISTS idx_session_events_request_id ON session_events(request_id);
CREATE INDEX IF NOT EXISTS idx_session_events_session_id ON session_events(session_id);
CREATE INDEX IF NOT EXISTS idx_session_events_session_turn ON session_events(session_id, turn, id);
CREATE INDEX IF NOT EXISTS idx_session_events_source ON session_events("source");
CREATE INDEX IF NOT EXISTS idx_session_events_tenant_project ON session_events(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_session_events_tool_name ON session_events(tool_name);
CREATE INDEX IF NOT EXISTS idx_session_events_trace_id ON session_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events("type");
