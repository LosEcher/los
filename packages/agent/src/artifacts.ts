import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getDb } from '@los/infra/db';
import { appendSessionEvent } from './session-events.js';

export type ArtifactOperation = 'put' | 'get' | 'list' | 'delete';
export type ArtifactPathPolicy = 'workspace-relative' | 'artifact-store' | 'read-only-export';

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
  _initialized = true;
}

export async function putArtifact(input: PutArtifactInput): Promise<ArtifactRecord> {
  await ensureArtifactStore();
  const artifactId = normalizeArtifactId(input.artifactId) ?? `artifact-${randomUUID()}`;
  const nodeId = requireString(input.nodeId, 'nodeId');
  const storageRoot = resolve(input.storageRoot);
  const storagePath = join(storageRoot, `${artifactId}.bin`);
  const checksum = createHash('sha256').update(input.content).digest('hex');
  const pathPolicy = normalizePathPolicy(input.pathPolicy);
  const contentType = normalizeOptionalString(input.contentType) ?? 'application/octet-stream';

  await mkdir(storageRoot, { recursive: true });
  await writeFile(storagePath, input.content);

  const db = getDb();
  const rows = await db.query<ArtifactRow>(
    `
    INSERT INTO artifacts (
      artifact_id, node_id, session_id, task_run_id, trace_id, request_id,
      workspace_root, original_path, path_policy, storage_path, size_bytes,
      checksum, checksum_algorithm, content_type, metadata_json, updated_at, deleted_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'sha256', $13, $14::jsonb, now(), NULL)
    ON CONFLICT (artifact_id) DO UPDATE
      SET node_id = EXCLUDED.node_id,
          session_id = EXCLUDED.session_id,
          task_run_id = EXCLUDED.task_run_id,
          trace_id = EXCLUDED.trace_id,
          request_id = EXCLUDED.request_id,
          workspace_root = EXCLUDED.workspace_root,
          original_path = EXCLUDED.original_path,
          path_policy = EXCLUDED.path_policy,
          storage_path = EXCLUDED.storage_path,
          size_bytes = EXCLUDED.size_bytes,
          checksum = EXCLUDED.checksum,
          checksum_algorithm = EXCLUDED.checksum_algorithm,
          content_type = EXCLUDED.content_type,
          metadata_json = EXCLUDED.metadata_json,
          updated_at = now(),
          deleted_at = NULL
    RETURNING *
  `,
    [
      artifactId,
      nodeId,
      normalizeOptionalString(input.sessionId) ?? null,
      normalizeOptionalString(input.taskRunId) ?? null,
      normalizeOptionalString(input.traceId) ?? null,
      normalizeOptionalString(input.requestId) ?? null,
      normalizeOptionalString(input.workspaceRoot) ?? null,
      normalizeOptionalString(input.path) ?? null,
      pathPolicy,
      storagePath,
      input.content.byteLength,
      checksum,
      contentType,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  const record = rowToArtifact(assertRow(rows.rows[0]));
  await appendArtifactEvent('artifact.put', record);
  return record;
}

export async function listArtifacts(options: ListArtifactsOptions = {}): Promise<ArtifactRecord[]> {
  await ensureArtifactStore();
  const limit = normalizeLimit(options.limit);
  const db = getDb();
  const rows = await db.query<ArtifactRow>(
    `
    SELECT *
    FROM artifacts
    WHERE ($2::text IS NULL OR node_id = $2)
      AND ($3::text IS NULL OR session_id = $3)
      AND ($4::text IS NULL OR task_run_id = $4)
      AND ($5::boolean = true OR deleted_at IS NULL)
    ORDER BY created_at DESC
    LIMIT $1
  `,
    [
      limit,
      normalizeOptionalString(options.nodeId) ?? null,
      normalizeOptionalString(options.sessionId) ?? null,
      normalizeOptionalString(options.taskRunId) ?? null,
      options.includeDeleted === true,
    ],
  );
  return rows.rows.map(rowToArtifact);
}

export async function loadArtifact(artifactId: string, options: { includeDeleted?: boolean } = {}): Promise<ArtifactRecord | null> {
  await ensureArtifactStore();
  const normalized = requireArtifactId(artifactId);
  const db = getDb();
  const rows = await db.query<ArtifactRow>(
    `
    SELECT *
    FROM artifacts
    WHERE artifact_id = $1
      AND ($2::boolean = true OR deleted_at IS NULL)
  `,
    [normalized, options.includeDeleted === true],
  );
  return rows.rows[0] ? rowToArtifact(rows.rows[0]) : null;
}

export async function readArtifactContent(artifactId: string): Promise<{ record: ArtifactRecord; content: Buffer } | null> {
  const record = await loadArtifact(artifactId);
  if (!record) return null;
  const content = await readFile(record.storagePath);
  const checksum = createHash('sha256').update(content).digest('hex');
  if (checksum !== record.checksum) {
    throw new Error(`artifact checksum mismatch: ${record.artifactId}`);
  }
  await appendArtifactEvent('artifact.get', record);
  return { record, content };
}

export async function deleteArtifact(artifactId: string, reason?: string): Promise<ArtifactRecord | null> {
  await ensureArtifactStore();
  const existing = await loadArtifact(artifactId);
  if (!existing) return null;

  await rm(existing.storagePath, { force: true }).catch(() => undefined);
  const db = getDb();
  const rows = await db.query<ArtifactRow>(
    `
    UPDATE artifacts
    SET deleted_at = now(),
        updated_at = now(),
        metadata_json = metadata_json || $2::jsonb
    WHERE artifact_id = $1
    RETURNING *
  `,
    [existing.artifactId, JSON.stringify(reason ? { deleteReason: reason } : {})],
  );
  const record = rowToArtifact(assertRow(rows.rows[0]));
  await appendArtifactEvent('artifact.delete', record);
  return record;
}

async function appendArtifactEvent(type: string, record: ArtifactRecord): Promise<void> {
  if (!record.sessionId) return;
  await appendSessionEvent({
    sessionId: record.sessionId,
    nodeId: record.nodeId,
    requestId: record.requestId,
    traceId: record.traceId,
    type,
    source: 'los',
    payload: {
      artifactId: record.artifactId,
      taskRunId: record.taskRunId ?? null,
      pathPolicy: record.pathPolicy,
      originalPath: record.originalPath ?? null,
      sizeBytes: record.sizeBytes,
      checksum: record.checksum,
      checksumAlgorithm: record.checksumAlgorithm,
      contentType: record.contentType,
      deletedAt: record.deletedAt ?? null,
    },
  });
}

type ArtifactRow = {
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
  metadata_json: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
};

function rowToArtifact(row: ArtifactRow): ArtifactRecord {
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
    metadata: normalizeJsonObject(row.metadata_json),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    deletedAt: row.deleted_at ? toIsoString(row.deleted_at) : undefined,
  };
}

function normalizeArtifactId(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return undefined;
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new Error('artifactId contains unsupported characters');
  }
  return normalized;
}

function requireArtifactId(value: unknown): string {
  return normalizeArtifactId(value) ?? (() => { throw new Error('artifactId is required'); })();
}

function requireString(value: unknown, name: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function normalizePathPolicy(value: unknown): ArtifactPathPolicy {
  if (value === 'workspace-relative' || value === 'read-only-export') return value;
  return 'artifact-store';
}

function normalizeLimit(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(1, Math.min(Math.floor(value), 500));
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(1, Math.min(Math.floor(parsed), 500));
  }
  return 50;
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('Artifact write failed');
  return row;
}
