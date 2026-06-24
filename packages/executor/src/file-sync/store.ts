// Store: PostgreSQL-backed file-sync metadata operations.
import { randomUUID } from 'node:crypto';
import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';

const log = getLogger('file-sync-store');

export interface FileSyncFolder {
  folderId: string;
  name: string;
  localPath: string;
  status: 'active' | 'archived' | 'error';
  scanIntervalSec: number;
  settleWindowSec: number;
  lastScanAt?: string;
  lastScanDurationMs?: number;
  nodeId: string;
  createdAt: string;
  updatedAt: string;
}

export interface FileSyncEntry {
  entryId: string;
  folderId: string;
  filePath: string;
  size: number;
  mtimeNs: number;
  inode: number;
  sha256?: string;
  status: 'in_sync' | 'target_missing' | 'tombstone';
  changeType?: 'added' | 'modified' | 'unchanged' | 'removed';
  versionSeq: number;
  sourceNode: string;
  scannedAt?: string;
  changedAt?: string;
  tombstoneAt?: string;
}

export interface FileSyncEvent {
  eventId: string;
  folderId?: string;
  filePath?: string;
  event: string;
  nodeId: string;
  detail: Record<string, unknown>;
  seq: number;
  createdAt: string;
}

export interface FileSyncManifest {
  manifestId: string;
  folderId: string;
  scanId: string;
  kind: 'source' | 'target';
  fileCount: number;
  totalSize: number;
  createdAt: string;
}

export interface FileSyncQueueItem {
  queueId: string;
  folderId: string;
  filePath: string;
  size: number;
  mtimeNs: number;
  state: 'ready' | 'transferring' | 'verifying' | 'done' | 'retry' | 'cooldown' | 'reconcile' | 'dead_letter';
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

// DB row shapes with snake_case columns
interface FolderRow {
  folder_id: string; name: string; local_path: string; status: string;
  scan_interval_sec: number; settle_window_sec: number;
  last_scan_at: string | null; last_scan_duration_ms: number | null;
  node_id: string; created_at: Date | string; updated_at: Date | string;
}
interface EntryRow {
  entry_id: string; folder_id: string; file_path: string; size: number;
  mtime_ns: number; inode: number; sha256: string | null; status: string;
  change_type: string | null; version_seq: number; source_node: string;
  scanned_at: Date | string | null; changed_at: Date | string | null;
  tombstone_at: Date | string | null;
}
interface EventRow {
  event_id: string; folder_id: string | null; file_path: string | null;
  event: string; node_id: string; detail: unknown; seq: number;
  created_at: Date | string;
}

let schemaReady = false;

async function ensureSchema() {
  if (schemaReady) return;
  const db = getDb();
  // Schema is created by migration 005_file_sync.sql
  schemaReady = true;
}

export function createFileSyncStore() {
  return {
    getOrCreateFolder,
    listFolders,
    upsertFileEntry,
    markStaleFiles,
    detectChangeType,
    listChangedFiles,
    updateFileSha256,
    endScan,
    insertEvent,
    recentEvents,
    getFolderStats,
    getAllFolderStats,
  };
}

export type FileSyncStore = ReturnType<typeof createFileSyncStore>;

async function getOrCreateFolder(input: {
  folderId: string; name: string; localPath: string; nodeId: string;
}): Promise<FileSyncFolder> {
  await ensureSchema();
  const db = getDb();

  const existing = await db.query<FolderRow>(
    `SELECT * FROM file_sync_folders WHERE folder_id = $1`,
    [input.folderId],
  );
  if (existing.rows[0]) return rowToFolder(existing.rows[0]);

  const rows = await db.query<FolderRow>(
    `INSERT INTO file_sync_folders (folder_id, name, local_path, node_id)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [input.folderId, input.name, input.localPath, input.nodeId],
  );
  return rowToFolder(rows.rows[0]!);
}

async function listFolders(nodeId?: string): Promise<FileSyncFolder[]> {
  await ensureSchema();
  const db = getDb();
  const rows = nodeId
    ? await db.query<FolderRow>(`SELECT * FROM file_sync_folders WHERE node_id = $1 ORDER BY name`, [nodeId])
    : await db.query<FolderRow>(`SELECT * FROM file_sync_folders ORDER BY name`);
  return rows.rows.map(rowToFolder);
}

async function upsertFileEntry(input: {
  folderId: string; filePath: string; size: number; mtimeNs: number;
  inode: number; sourceNode: string;
}): Promise<FileSyncEntry> {
  await ensureSchema();
  const db = getDb();
  const entryId = `entry-${input.folderId}-${encodeURIComponent(input.filePath)}`;

  const existing = await db.query<EntryRow>(
    `SELECT * FROM file_sync_entries WHERE entry_id = $1`,
    [entryId],
  );
  const old = existing.rows[0];

  const changeType = detectChangeType(old, input);
  const now = new Date().toISOString();

  const rows = await db.query<EntryRow>(
    `INSERT INTO file_sync_entries
       (entry_id, folder_id, file_path, size, mtime_ns, inode,
        status, change_type, source_node, scanned_at, changed_at, version_seq)
     VALUES ($1,$2,$3,$4,$5,$6,
        $7, $8, $9, $10::timestamptz,
        CASE WHEN $8 IN ('added','modified') THEN $10::timestamptz ELSE NULL END,
        1)
     ON CONFLICT (folder_id, file_path) DO UPDATE SET
       size = EXCLUDED.size,
       mtime_ns = EXCLUDED.mtime_ns,
       inode = EXCLUDED.inode,
       status = EXCLUDED.status,
       change_type = EXCLUDED.change_type,
       source_node = EXCLUDED.source_node,
       scanned_at = EXCLUDED.scanned_at,
       changed_at = CASE
         WHEN EXCLUDED.change_type IN ('added','modified') THEN $10::timestamptz
         ELSE file_sync_entries.changed_at
       END,
       version_seq = file_sync_entries.version_seq + 1
     RETURNING *`,
    [
      entryId, input.folderId, input.filePath, input.size, input.mtimeNs, input.inode,
      'in_sync', changeType, input.sourceNode, now,
    ],
  );
  return rowToEntry(rows.rows[0]!);
}

function detectChangeType(
  old: EntryRow | undefined,
  input: { size: number; mtimeNs: number },
): 'added' | 'modified' | 'unchanged' {
  if (!old) return 'added';
  if (old.status === 'tombstone') return 'added';
  if (Number(old.size) === input.size && Number(old.mtime_ns) === input.mtimeNs) return 'unchanged';
  return 'modified';
}

async function markStaleFiles(
  folderId: string,
  nodeId: string,
  seenPaths: Set<string>,
): Promise<Array<{ entryId: string; filePath: string }>> {
  await ensureSchema();
  const db = getDb();
  const all = await db.query<EntryRow>(
    `SELECT * FROM file_sync_entries WHERE folder_id = $1 AND status != 'tombstone'`,
    [folderId],
  );
  const stale = all.rows.filter(r => !seenPaths.has(r.file_path));
  if (!stale.length) return [];

  const ids = stale.map(r => r.entry_id);
  if (!ids.length) return [];
  await db.query(
    `UPDATE file_sync_entries
     SET status = 'target_missing', change_type = 'removed', tombstone_at = now()
     WHERE folder_id = $1 AND entry_id = ANY($2)`,
    [folderId, ids],
  );
  return stale.map(r => ({ entryId: r.entry_id, filePath: r.file_path }));
}

async function listChangedFiles(folderId: string, scanId: string): Promise<FileSyncEntry[]> {
  await ensureSchema();
  const db = getDb();
  const rows = await db.query<EntryRow>(
    `SELECT * FROM file_sync_entries
     WHERE folder_id = $1 AND change_type IN ('added','modified')`,
    [folderId],
  );
  return rows.rows.map(rowToEntry);
}

async function updateFileSha256(entryId: string, sha256: string): Promise<void> {
  const db = getDb();
  await db.query(`UPDATE file_sync_entries SET sha256 = $2 WHERE entry_id = $1`, [entryId, sha256]);
}

async function endScan(input: {
  folderId: string; nodeId: string; changeCount: number; durationMs: number;
}): Promise<void> {
  const db = getDb();
  await db.query(
    `UPDATE file_sync_folders SET last_scan_at = now(), last_scan_duration_ms = $2 WHERE folder_id = $1`,
    [input.folderId, input.durationMs],
  );
  await insertEvent({
    folderId: input.folderId,
    event: 'scan_complete',
    nodeId: input.nodeId,
    detail: { changes: input.changeCount, durationMs: input.durationMs },
    seq: 0,
  });
}

async function insertEvent(input: {
  folderId?: string; filePath?: string; event: string; nodeId: string;
  detail: Record<string, unknown>; seq: number;
}): Promise<FileSyncEvent> {
  await ensureSchema();
  const db = getDb();
  const eventId = `event-${randomUUID()}`;
  const rows = await db.query<EventRow>(
    `INSERT INTO file_sync_events (event_id, folder_id, file_path, event, node_id, detail, seq)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING *`,
    [eventId, input.folderId ?? null, input.filePath ?? null, input.event, input.nodeId, JSON.stringify(input.detail), input.seq],
  );
  return rowToEvent(rows.rows[0]!);
}

async function recentEvents(limit: number = 50): Promise<FileSyncEvent[]> {
  await ensureSchema();
  const db = getDb();
  const rows = await db.query<EventRow>(
    `SELECT * FROM file_sync_events ORDER BY created_at DESC LIMIT $1`,
    [Math.min(limit, 500)],
  );
  return rows.rows.map(rowToEvent);
}

async function getFolderStats(folderId: string): Promise<{
  totalFiles: number; totalSize: number; status: string; lastScanAt?: string;
} | null> {
  await ensureSchema();
  const db = getDb();
  const rows = await db.query<{ total_files: string; total_size: string; status: string; last_scan_at: string | null }>(
    `SELECT COUNT(*)::text AS total_files,
            COALESCE(SUM(size), 0)::text AS total_size,
            f.status,
            f.last_scan_at
     FROM file_sync_folders f
     LEFT JOIN file_sync_entries fe ON fe.folder_id = f.folder_id AND fe.status != 'tombstone'
     WHERE f.folder_id = $1
     GROUP BY f.folder_id`,
    [folderId],
  );
  if (!rows.rows[0]) return null;
  const r = rows.rows[0];
  return {
    totalFiles: Number(r.total_files),
    totalSize: Number(r.total_size),
    status: r.status,
    lastScanAt: r.last_scan_at ?? undefined,
  };
}

async function getAllFolderStats(): Promise<Array<{
  folderId: string; name: string; localPath: string; totalFiles: number; totalSize: number;
  status: string; lastScanAt?: string; nodeId: string;
}>> {
  await ensureSchema();
  const db = getDb();
  const rows = await db.query<{
    folder_id: string; name: string; local_path: string; status: string;
    last_scan_at: string | null; total_files: string; total_size: string; node_id: string;
  }>(
    `SELECT f.folder_id, f.name, f.local_path, f.status, f.last_scan_at,
            COUNT(fe.entry_id)::text AS total_files,
            COALESCE(SUM(fe.size), 0)::text AS total_size,
            f.node_id
     FROM file_sync_folders f
     LEFT JOIN file_sync_entries fe ON fe.folder_id = f.folder_id AND fe.status != 'tombstone'
     GROUP BY f.folder_id
     ORDER BY f.name`,
  );
  return rows.rows.map(r => ({
    folderId: r.folder_id,
    name: r.name,
    localPath: r.local_path,
    totalFiles: Number(r.total_files),
    totalSize: Number(r.total_size),
    status: r.status,
    lastScanAt: r.last_scan_at ?? undefined,
    nodeId: r.node_id,
  }));
}

function rowToFolder(row: FolderRow): FileSyncFolder {
  return {
    folderId: row.folder_id, name: row.name, localPath: row.local_path,
    status: row.status as FileSyncFolder['status'],
    scanIntervalSec: row.scan_interval_sec, settleWindowSec: row.settle_window_sec,
    lastScanAt: row.last_scan_at ?? undefined,
    lastScanDurationMs: row.last_scan_duration_ms ?? undefined,
    nodeId: row.node_id,
    createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at),
  };
}

function rowToEntry(row: EntryRow): FileSyncEntry {
  return {
    entryId: row.entry_id, folderId: row.folder_id, filePath: row.file_path,
    size: Number(row.size), mtimeNs: Number(row.mtime_ns), inode: Number(row.inode),
    sha256: row.sha256 ?? undefined,
    status: row.status as FileSyncEntry['status'],
    changeType: (row.change_type as FileSyncEntry['changeType']) ?? undefined,
    versionSeq: row.version_seq, sourceNode: row.source_node,
    scannedAt: row.scanned_at ? toIso(row.scanned_at) : undefined,
    changedAt: row.changed_at ? toIso(row.changed_at) : undefined,
    tombstoneAt: row.tombstone_at ? toIso(row.tombstone_at) : undefined,
  };
}

function rowToEvent(row: EventRow): FileSyncEvent {
  return {
    eventId: row.event_id, folderId: row.folder_id ?? undefined,
    filePath: row.file_path ?? undefined, event: row.event, nodeId: row.node_id,
    detail: normalizeJsonObject(row.detail), seq: row.seq,
    createdAt: toIso(row.created_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try { const p = JSON.parse(value); return p && typeof p === 'object' && !Array.isArray(p) ? p : {}; } catch { return {}; }
  }
  return {};
}
