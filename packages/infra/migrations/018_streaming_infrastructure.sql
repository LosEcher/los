-- 018_streaming_infrastructure.sql
-- stream_checkpoints, stream_leases

CREATE TABLE IF NOT EXISTS stream_checkpoints (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_spec_id TEXT,
  task_run_id TEXT,
  event_type TEXT NOT NULL,
  turn INTEGER NOT NULL DEFAULT 0,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stream_checkpoints_session ON stream_checkpoints(session_id, id);
CREATE INDEX IF NOT EXISTS idx_stream_checkpoints_run_spec ON stream_checkpoints(run_spec_id, id);

CREATE TABLE IF NOT EXISTS stream_leases (
  task_run_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  session_id TEXT,
  run_spec_id TEXT,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stream_leases_node ON stream_leases(node_id);
CREATE INDEX IF NOT EXISTS idx_stream_leases_expires ON stream_leases(lease_expires_at);
