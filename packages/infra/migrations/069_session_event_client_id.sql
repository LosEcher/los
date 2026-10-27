-- 069_session_event_client_id: idempotent executor→gateway event delivery
--
-- Stateless executors retry event batches after a transport failure. The
-- client event id makes a replay idempotent per session without changing the
-- existing serial primary key.

ALTER TABLE session_events
  ADD COLUMN IF NOT EXISTS client_event_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_events_client_event
  ON session_events(session_id, client_event_id)
  WHERE client_event_id IS NOT NULL;
