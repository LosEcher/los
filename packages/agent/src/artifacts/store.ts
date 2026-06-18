import { getDb } from '@los/infra/db';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  session_id TEXT,
  task_run_id TEXT,
  trace_id TEXT,
  request_id TEXT,
  workspace_root TEXT,
  original_path TEXT,
  path_policy TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  checksum TEXT NOT NULL,
  checksum_algorithm TEXT NOT NULL DEFAULT 'sha256',
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  status TEXT NOT NULL DEFAULT 'draft',
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_artifacts_node_id ON artifacts(node_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_session_id ON artifacts(session_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_task_run_id ON artifacts(task_run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_trace_id ON artifacts(trace_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_deleted ON artifacts(deleted_at);
`;

let _initialized = false;

export async function ensureArtifactStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(SCHEMA);
  // Idempotent schema evolution for columns added after initial creation.
  // The migration 011_artifact_status.sql handles this for production DBs;
  // this ensures test/CI DBs are also up to date.
  await db.exec(`
    ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft';
    ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5;
    CREATE INDEX IF NOT EXISTS idx_artifacts_status ON artifacts(status);
  `);
  _initialized = true;
}
