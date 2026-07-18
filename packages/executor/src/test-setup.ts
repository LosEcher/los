import { after } from 'node:test';
import { loadConfig } from '@los/infra/config';
import { _configureTestSchema, _dropConfiguredTestSchema, initDb, getDb } from '@los/infra/db';
import { ensureAllAgentStores } from '@los/agent/ensure-all-stores';

// Pre-initialize DB for executor package tests.
// ensureAllAgentStores() covers all agent-owned stores (including
// executor_node + artifact which executor tests depend on).

_configureTestSchema('executor');
const config = await loadConfig();
await initDb(config.databaseUrl);
after(async () => await _dropConfiguredTestSchema(config.databaseUrl));
await ensureAllAgentStores();

// Ensure schema for file-sync tables (created by migration 005).
// Production applies migrations during gateway/executor startup; test setup
// creates the focused tables so package tests remain isolated.
const db = getDb();
const MIGRATION_005 = `
CREATE TABLE IF NOT EXISTS file_sync_folders (
    folder_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    local_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    scan_interval_sec INTEGER NOT NULL DEFAULT 1800,
    settle_window_sec INTEGER NOT NULL DEFAULT 900,
    last_scan_at TIMESTAMPTZ,
    last_scan_duration_ms INTEGER,
    node_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_file_sync_folders_node ON file_sync_folders(node_id);

CREATE TABLE IF NOT EXISTS file_sync_entries (
    entry_id TEXT PRIMARY KEY,
    folder_id TEXT NOT NULL REFERENCES file_sync_folders(folder_id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    size BIGINT NOT NULL,
    mtime_ns BIGINT NOT NULL DEFAULT 0,
    inode BIGINT NOT NULL DEFAULT 0,
    sha256 TEXT,
    status TEXT NOT NULL DEFAULT 'in_sync',
    change_type TEXT,
    version_seq INTEGER NOT NULL DEFAULT 0,
    source_node TEXT NOT NULL DEFAULT '',
    scanned_at TIMESTAMPTZ,
    changed_at TIMESTAMPTZ,
    tombstone_at TIMESTAMPTZ,
    UNIQUE(folder_id, file_path)
);

CREATE TABLE IF NOT EXISTS file_sync_events (
    event_id TEXT PRIMARY KEY,
    folder_id TEXT,
    file_path TEXT,
    event TEXT NOT NULL,
    node_id TEXT NOT NULL DEFAULT '',
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    seq INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS file_sync_manifests (
    manifest_id TEXT PRIMARY KEY,
    folder_id TEXT NOT NULL REFERENCES file_sync_folders(folder_id) ON DELETE CASCADE,
    scan_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('source', 'target')),
    file_count INTEGER NOT NULL DEFAULT 0,
    total_size BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS file_sync_queue (
    queue_id TEXT PRIMARY KEY,
    folder_id TEXT NOT NULL REFERENCES file_sync_folders(folder_id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    size BIGINT NOT NULL,
    mtime_ns BIGINT NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'ready',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// Split into individual statements since db.exec may not exist on all DbConnection wrappers
const statements = MIGRATION_005
  .split(';')
  .map(s => s.trim())
  .filter(s => s.length > 0);

for (const stmt of statements) {
  await db.query(stmt);
}
