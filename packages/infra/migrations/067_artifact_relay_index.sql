-- 067_artifact_relay_index: keep remote artifact indexes out of `artifacts`
--
-- Gateway and executor may share one database. Writing a remote index row into
-- `artifacts` (storage_path `executor://...`) makes the owner executor read its
-- own artifact as a local file and fail with ENOENT; the 2026-10-18 live relay
-- test reproduced this. Remote indexes are gateway-only and live here.

CREATE TABLE IF NOT EXISTS artifact_relay_index (
  artifact_id TEXT PRIMARY KEY,
  remote_artifact_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  checksum TEXT NOT NULL,
  content_type TEXT NOT NULL,
  original_path TEXT,
  path_policy TEXT NOT NULL DEFAULT 'artifact-store',
  session_id TEXT,
  task_run_id TEXT,
  trace_id TEXT,
  request_id TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_artifact_relay_index_node
  ON artifact_relay_index(node_id, created_at DESC);
