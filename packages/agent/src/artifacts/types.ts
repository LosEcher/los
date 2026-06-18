export type ArtifactOperation = 'put' | 'get' | 'list' | 'delete';
export type ArtifactPathPolicy = 'workspace-relative' | 'artifact-store' | 'read-only-export';

/** Artifact confidence lifecycle. Only 'confirmed' requires human attestation. */
export type ArtifactStatus = 'draft' | 'candidate' | 'reviewed' | 'confirmed' | 'rejected';

/** Statuses that AI agents are allowed to set. 'confirmed' is HUMAN_ONLY. */
export const AGENT_WRITABLE_STATUSES: ArtifactStatus[] = ['draft', 'candidate', 'reviewed', 'rejected'];

export interface ArtifactRecord {
  artifactId: string;
  nodeId: string;
  sessionId?: string;
  taskRunId?: string;
  traceId?: string;
  requestId?: string;
  workspaceRoot?: string;
  originalPath?: string;
  pathPolicy: ArtifactPathPolicy;
  storagePath: string;
  sizeBytes: number;
  checksum: string;
  checksumAlgorithm: 'sha256';
  contentType: string;
  /** Confidence lifecycle status. Agent-created artifacts default to 'draft'. */
  status: ArtifactStatus;
  /** Judge/source confidence score (0-1). */
  confidence: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface PutArtifactInput {
  artifactId?: string;
  nodeId: string;
  sessionId?: string;
  taskRunId?: string;
  traceId?: string;
  requestId?: string;
  workspaceRoot?: string;
  path?: string;
  pathPolicy?: ArtifactPathPolicy;
  content: Buffer;
  contentType?: string;
  /** Agent-provided confidence (0-1). Default 0.5 for agent-created artifacts. */
  confidence?: number;
  metadata?: Record<string, unknown>;
  storageRoot: string;
}

export interface ListArtifactsOptions {
  limit?: number;
  nodeId?: string;
  sessionId?: string;
  taskRunId?: string;
  includeDeleted?: boolean;
}

export type ArtifactRow = {
  artifact_id: string;
  node_id: string;
  session_id: string | null;
  task_run_id: string | null;
  trace_id: string | null;
  request_id: string | null;
  workspace_root: string | null;
  original_path: string | null;
  path_policy: ArtifactPathPolicy;
  storage_path: string;
  size_bytes: number | string;
  checksum: string;
  checksum_algorithm: 'sha256';
  content_type: string;
  status: ArtifactStatus;
  confidence: number | string;
  metadata_json: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
};
