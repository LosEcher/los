-- 040_runtime_schema_alignment.sql
-- Align migration-owned schema with runtime compatibility stores.

ALTER TABLE mcp_servers
  ALTER COLUMN enabled SET DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_events_operator_control_consumed
  ON session_events(session_id, parent_event_id)
  WHERE type = 'operator.control.consumed' AND parent_event_id IS NOT NULL;
