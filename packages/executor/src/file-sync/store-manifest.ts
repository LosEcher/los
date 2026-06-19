// Store-manifest: PostgreSQL-backed file_sync_manifests operations.
// Extracted from store.ts to keep it under the 400-line gate.
import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import type { FileSyncManifest } from './store.js';

const log = getLogger('file-sync-store-manifest');

interface ManifestRow {
  manifest_id: string;
  folder_id: string;
  scan_id: string;
  kind: string;
  file_count: number;
  total_size: string;
  created_at: Date | string;
}

function rowToManifest(row: ManifestRow): FileSyncManifest {
  return {
    manifestId: row.manifest_id,
    folderId: row.folder_id,
    scanId: row.scan_id,
    kind: row.kind as FileSyncManifest['kind'],
    fileCount: row.file_count,
    totalSize: Number(row.total_size),
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : new Date(row.created_at).toISOString(),
  };
}

export async function createManifest(input: {
  folderId: string;
  scanId: string;
  kind: 'source' | 'target';
  fileCount: number;
  totalSize: number;
}): Promise<FileSyncManifest> {
  const db = getDb();
  const manifestId = `manifest-${input.folderId}-${input.scanId}-${input.kind}`;
  const rows = await db.query<ManifestRow>(
    `INSERT INTO file_sync_manifests (manifest_id, folder_id, scan_id, kind, file_count, total_size)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (manifest_id) DO UPDATE SET
       file_count = EXCLUDED.file_count,
       total_size = EXCLUDED.total_size
     RETURNING *`,
    [manifestId, input.folderId, input.scanId, input.kind, input.fileCount, input.totalSize],
  );
  const row = rows.rows[0];
  if (!row) throw new Error(`failed to create manifest ${manifestId}`);
  log.debug(`created manifest ${manifestId}: ${input.fileCount} files, ${input.totalSize} bytes`);
  return rowToManifest(row);
}

export async function getLatestManifest(
  folderId: string,
  kind: 'source' | 'target' = 'source',
): Promise<FileSyncManifest | null> {
  const db = getDb();
  const rows = await db.query<ManifestRow>(
    `SELECT * FROM file_sync_manifests
     WHERE folder_id = $1 AND kind = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [folderId, kind],
  );
  return rows.rows[0] ? rowToManifest(rows.rows[0]) : null;
}

export async function listManifests(
  folderId: string,
  limit: number = 10,
): Promise<FileSyncManifest[]> {
  const db = getDb();
  const rows = await db.query<ManifestRow>(
    `SELECT * FROM file_sync_manifests
     WHERE folder_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [folderId, Math.min(limit, 100)],
  );
  return rows.rows.map(rowToManifest);
}
