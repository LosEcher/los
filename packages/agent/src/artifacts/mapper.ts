import type { ArtifactRecord, ArtifactRow } from './types.js';
import { normalizeArtifactStatus, normalizeJsonObject, normalizeOptionalString, normalizePathPolicy, toIsoString } from './helpers.js';

export function rowToArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    artifactId: row.artifact_id,
    nodeId: row.node_id,
    sessionId: row.session_id ?? undefined,
    taskRunId: row.task_run_id ?? undefined,
    traceId: row.trace_id ?? undefined,
    requestId: row.request_id ?? undefined,
    workspaceRoot: row.workspace_root ?? undefined,
    originalPath: row.original_path ?? undefined,
    pathPolicy: normalizePathPolicy(row.path_policy),
    storagePath: row.storage_path,
    sizeBytes: Number(row.size_bytes),
    checksum: row.checksum,
    checksumAlgorithm: 'sha256',
    contentType: row.content_type,
    status: normalizeArtifactStatus(row.status),
    confidence: typeof row.confidence === 'number' ? row.confidence : Number(row.confidence) || 0.5,
    metadata: normalizeJsonObject(row.metadata_json),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    deletedAt: row.deleted_at ? toIsoString(row.deleted_at) : undefined,
  };
}
