import { getDb } from '@los/infra/db';
import type { ArtifactPathPolicy } from './types.js';

/**
 * Gateway-side index for artifacts whose bytes live on a remote executor.
 *
 * This is deliberately **not** the `artifacts` table: gateway and executor can
 * share one database, and a remote index row written into `artifacts` would be
 * read by the owner executor as if it were a local file (`executor://...`),
 * breaking `GET /v1/artifacts/:id/content`. The live 2026-10-18 relay test
 * reproduced exactly that collision, so remote indexes get their own table.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS artifact_relay_index (
  artifact_id TEXT PRIMARY KEY,
  remote_artifact_id TEXT,
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
ALTER TABLE artifact_relay_index ADD COLUMN IF NOT EXISTS remote_artifact_id TEXT;
CREATE INDEX IF NOT EXISTS idx_artifact_relay_index_node ON artifact_relay_index(node_id, created_at DESC);
`;

let initialized = false;

export interface RemoteArtifactIndexRecord {
  artifactId: string;
  remoteArtifactId: string;
  nodeId: string;
  sizeBytes: number;
  checksum: string;
  contentType: string;
  originalPath?: string;
  pathPolicy: ArtifactPathPolicy;
  sessionId?: string;
  taskRunId?: string;
  traceId?: string;
  requestId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

type Row = {
  artifact_id: string;
  remote_artifact_id: string | null;
  node_id: string;
  size_bytes: string | number;
  checksum: string;
  content_type: string;
  original_path: string | null;
  path_policy: string;
  session_id: string | null;
  task_run_id: string | null;
  trace_id: string | null;
  request_id: string | null;
  metadata_json: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

export async function ensureArtifactRelayIndexStore(): Promise<void> {
  if (initialized) return;
  await getDb().exec(SCHEMA);
  initialized = true;
}

export type RemoteArtifactIndexInput = Omit<RemoteArtifactIndexRecord, 'createdAt' | 'updatedAt'>;

export async function putRemoteArtifactIndex(input: RemoteArtifactIndexInput): Promise<RemoteArtifactIndexRecord> {
  await ensureArtifactRelayIndexStore();
  const rows = await getDb().query<Row>(
    `
    INSERT INTO artifact_relay_index (
      artifact_id, remote_artifact_id, node_id, size_bytes, checksum, content_type, original_path,
      path_policy, session_id, task_run_id, trace_id, request_id, metadata_json
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
    ON CONFLICT (artifact_id) DO UPDATE SET
      remote_artifact_id = EXCLUDED.remote_artifact_id,
      node_id = EXCLUDED.node_id,
      size_bytes = EXCLUDED.size_bytes,
      checksum = EXCLUDED.checksum,
      content_type = EXCLUDED.content_type,
      original_path = EXCLUDED.original_path,
      path_policy = EXCLUDED.path_policy,
      session_id = EXCLUDED.session_id,
      task_run_id = EXCLUDED.task_run_id,
      trace_id = EXCLUDED.trace_id,
      request_id = EXCLUDED.request_id,
      metadata_json = EXCLUDED.metadata_json,
      updated_at = now()
    RETURNING *
  `,
    [
      input.artifactId, input.remoteArtifactId, input.nodeId, input.sizeBytes, input.checksum, input.contentType,
      input.originalPath ?? null, input.pathPolicy, input.sessionId ?? null,
      input.taskRunId ?? null, input.traceId ?? null, input.requestId ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return rowToRecord(rows.rows[0]!);
}

export async function loadRemoteArtifactIndex(artifactId: string): Promise<RemoteArtifactIndexRecord | null> {
  await ensureArtifactRelayIndexStore();
  const rows = await getDb().query<Row>(
    'SELECT * FROM artifact_relay_index WHERE artifact_id = $1',
    [artifactId],
  );
  return rows.rows[0] ? rowToRecord(rows.rows[0]) : null;
}

export async function deleteRemoteArtifactIndex(artifactId: string): Promise<boolean> {
  await ensureArtifactRelayIndexStore();
  const rows = await getDb().query('DELETE FROM artifact_relay_index WHERE artifact_id = $1 RETURNING artifact_id', [artifactId]);
  return rows.rows.length > 0;
}

function rowToRecord(row: Row): RemoteArtifactIndexRecord {
  return {
    artifactId: row.artifact_id,
    remoteArtifactId: row.remote_artifact_id ?? row.artifact_id,
    nodeId: row.node_id,
    sizeBytes: Number(row.size_bytes),
    checksum: row.checksum,
    contentType: row.content_type,
    originalPath: row.original_path ?? undefined,
    pathPolicy: row.path_policy as ArtifactPathPolicy,
    sessionId: row.session_id ?? undefined,
    taskRunId: row.task_run_id ?? undefined,
    traceId: row.trace_id ?? undefined,
    requestId: row.request_id ?? undefined,
    metadata: (row.metadata_json && typeof row.metadata_json === 'object' && !Array.isArray(row.metadata_json))
      ? row.metadata_json as Record<string, unknown>
      : {},
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
