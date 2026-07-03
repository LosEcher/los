-- 026_worker_messages.sql
-- Worker contract layer: structured coordinator↔worker communication.
--
--   dispatch_id links worker messages to a specific execution attempt.
--   It matches task_attempts.id (the "dispatchId" in worker contract terms).
--   The same task re-dispatched gets a new attempt → new dispatch_id → old messages
--   are naturally scoped to the stale dispatch.
--
--   Message types:
--     worker_done  – worker finished (success or failure), carries summary
--     escalation   – worker needs human/upstream intervention
--     ask          – worker is blocked on a coordinator decision
--     heartbeat    – periodic liveness + phase annotation
--
--   Note: dispatch_id lives only on worker_messages. task_runs does NOT carry
--   a dispatch_id column — the worker_messages rows themselves are the audit
--   trail and can be joined back to task_runs via task_id. Adding a dead
--   dispatch_id column to task_runs (with no writer) was considered and
--   dropped to avoid schema/implementation drift.

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
