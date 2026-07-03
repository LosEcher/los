-- 026_worker_messages.sql
-- Worker contract layer: structured coordinator↔worker communication.
--
--   dispatch_id links worker messages to a specific execution attempt.
--   It matches agent_task_attempts.id (the "dispatchId" in worker contract terms).
--   The same task re-dispatched gets a new attempt → new dispatch_id → old messages
--   are naturally scoped to the stale dispatch.
--
--   Message types:
--     worker_done  – worker finished (success or failure), carries summary
--     escalation   – worker needs human/upstream intervention
--     ask          – worker is blocked on a coordinator decision
--     heartbeat    – periodic liveness + phase annotation

CREATE TABLE IF NOT EXISTS worker_messages (
  id TEXT PRIMARY KEY,
  dispatch_id TEXT,
  task_id TEXT,
  type TEXT NOT NULL DEFAULT 'heartbeat',
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_worker_messages_dispatch ON worker_messages(dispatch_id);
CREATE INDEX IF NOT EXISTS idx_worker_messages_task ON worker_messages(task_id);
CREATE INDEX IF NOT EXISTS idx_worker_messages_type ON worker_messages(type);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'worker_messages_type_chk'
      AND conrelid = 'worker_messages'::regclass
  ) THEN
    ALTER TABLE worker_messages
      ADD CONSTRAINT worker_messages_type_chk
      CHECK (type IN ('worker_done', 'escalation', 'ask', 'heartbeat'))
      NOT VALID;
  END IF;
END $$;

-- Add dispatch_id to task_runs so the row carries its active dispatch identity.
-- Nullable: existing rows have null, new rows set it at creation time.
-- No FK: dispatch_id references agent_task_attempts.id but the tables
-- are in different packages and we want loose coupling.
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS dispatch_id TEXT;

CREATE INDEX IF NOT EXISTS idx_task_runs_dispatch_id ON task_runs(dispatch_id);
