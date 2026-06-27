-- 018_streaming_infrastructure.sql
-- stream_checkpoints, stream_leases
--
-- Canonical schema mirrors the runtime ensure*Store definitions in
-- packages/agent/src/stream-checkpoints.ts and stream-lease.ts.
--
-- History: an earlier draft of this migration described a different
-- stream_leases shape (task_run_id PK + lease_expires_at) and a
-- stream_checkpoints shape with a task_run_id column. That schema was
-- never the runtime source of truth — ensure*Store created the tables
-- with the schema below, and the live DB diverged from the migration.
-- This migration is rewritten to match the canonical ensure*Store schema
-- so a fresh `db:migrate` produces what the gateway actually expects.
-- Idempotent: safe on fresh DBs, on tables already created by ensure,
-- and on tables carrying orphaned legacy columns.

CREATE TABLE IF NOT EXISTS stream_checkpoints (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_spec_id TEXT,
  turn INTEGER NOT NULL DEFAULT 0,
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stream_checkpoints_session_id
  ON stream_checkpoints(session_id, id);
CREATE INDEX IF NOT EXISTS idx_stream_checkpoints_run_spec_id
  ON stream_checkpoints(run_spec_id, id);
CREATE INDEX IF NOT EXISTS idx_stream_checkpoints_created
  ON stream_checkpoints(created_at);

CREATE TABLE IF NOT EXISTS stream_leases (
  lease_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  gateway TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stream_leases_status_check'
      AND conrelid = 'stream_leases'::regclass
  ) THEN
    ALTER TABLE stream_leases
      ADD CONSTRAINT stream_leases_status_check
      CHECK (status IN ('active', 'released', 'expired'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_stream_leases_session
  ON stream_leases(session_id, status);
CREATE INDEX IF NOT EXISTS idx_stream_leases_heartbeat
  ON stream_leases(heartbeat_at);

-- Drop orphaned legacy column from a prior ensure*Store schema revision.
-- Unused by current code (CREATE TABLE IF NOT EXISTS never removes columns,
-- so it lingered in DBs that ran the older ensure schema).
ALTER TABLE stream_leases DROP COLUMN IF EXISTS node_id;
