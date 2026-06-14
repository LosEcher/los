# sync-node Design Notes (absorbed)

Archived from `/Users/echerlos/syncthing/project/sync-node` on 2026-06-14.

## What it was
A per-node file-sync agent written in Go (~450 LOC + 35 LOC HTML dashboard).
Scanned folders, compared file metadata (size/mtime/inode) against a local SQLite
store, detected adds/modifications/removals, and served an HTMX dashboard on :8080.

## Key design patterns worth preserving

### Version Vectors (SQLite schema)
- `file_entries` table: path_id, size, mtime_ns, inode, sha256 (stub), status, version_seq, source_node
- `folder_peers` table: node_id, role, last_seen_seq
- `version_vectors` table: folder_id + node_id → seq (conflict detection primitive)
- `sync_events` table: event log with compaction support

### Scanner logic (scanner.go)
- WalkDir with seenPaths map → detect added/modified/unchanged
- MarkStaleFiles: files in DB but not seen during walk → removed
- detectChangeType: compare size + mtime against stored entry
- DeepVerify with SHA-256 was a stub (not implemented)

### Key decisions already made in los
- los executor already has node heartbeat, artifact transfer, command execution
- Storage should be PostgreSQL (not SQLite) for multi-node aggregation
- The incremental sync state machine from CONTINUOUS_SYNC_DESIGN.md supersedes sync-node's simpler model

## Migration target in los
- `packages/executor/src/file-sync/scanner.ts` — directory walker with change detection
- `packages/infra/migrations/004_file_sync.sql` — file_entries, file_names, sync_events tables
- `packages/gateway/src/routes/file-sync.ts` — REST API replacing sync-node's HTMX dashboard
