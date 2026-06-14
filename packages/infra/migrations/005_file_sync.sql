-- 005_file_sync: per-node file-sync metadata store.
-- Manages folder registrations, file entries with change detection,
-- version vectors, and sync event log.

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
CREATE INDEX IF NOT EXISTS idx_file_sync_folders_status ON file_sync_folders(status);

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
CREATE INDEX IF NOT EXISTS idx_file_sync_entries_folder_status ON file_sync_entries(folder_id, status);
CREATE INDEX IF NOT EXISTS idx_file_sync_entries_path ON file_sync_entries(file_path);
CREATE INDEX IF NOT EXISTS idx_file_sync_entries_mtime ON file_sync_entries(folder_id, mtime_ns);

CREATE TABLE IF NOT EXISTS file_sync_events (
    event_id TEXT PRIMARY KEY,
    folder_id TEXT REFERENCES file_sync_folders(folder_id) ON DELETE SET NULL,
    file_path TEXT,
    event TEXT NOT NULL,
    node_id TEXT NOT NULL DEFAULT '',
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    seq INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_file_sync_events_folder_ts ON file_sync_events(folder_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_sync_events_event ON file_sync_events(event);
CREATE INDEX IF NOT EXISTS idx_file_sync_events_node ON file_sync_events(node_id);

CREATE TABLE IF NOT EXISTS file_sync_manifests (
    manifest_id TEXT PRIMARY KEY,
    folder_id TEXT NOT NULL REFERENCES file_sync_folders(folder_id) ON DELETE CASCADE,
    scan_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('source', 'target')),
    file_count INTEGER NOT NULL DEFAULT 0,
    total_size BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_file_sync_manifests_scan ON file_sync_manifests(scan_id);

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
CREATE INDEX IF NOT EXISTS idx_file_sync_queue_folder_state ON file_sync_queue(folder_id, state);
CREATE INDEX IF NOT EXISTS idx_file_sync_queue_state ON file_sync_queue(state);
