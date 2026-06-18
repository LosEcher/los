import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getDb } from '@los/infra/db';
import type { ArtifactRecord, ArtifactRow, PutArtifactInput, ListArtifactsOptions } from './types.js';
import { AGENT_WRITABLE_STATUSES } from './types.js';
import { ensureArtifactStore } from './store.js';
import {
  normalizeArtifactId, normalizeLimit, normalizeOptionalString,
  normalizePathPolicy, requireArtifactId, requireString, assertRow,
} from './helpers.js';
import { rowToArtifact } from './mapper.js';
import { appendArtifactEvent } from './events.js';
import { appendSessionEvent } from '../session-events.js';

export async function putArtifact(input: PutArtifactInput): Promise<ArtifactRecord> {
  await ensureArtifactStore();
  const artifactId = normalizeArtifactId(input.artifactId) ?? `artifact-${randomUUID()}`;
  const nodeId = requireString(input.nodeId, 'nodeId');
  const storageRoot = resolve(input.storageRoot);
  const storagePath = join(storageRoot, `${artifactId}.bin`);
  const checksum = createHash('sha256').update(input.content).digest('hex');
  const pathPolicy = normalizePathPolicy(input.pathPolicy);
  const contentType = normalizeOptionalString(input.contentType) ?? 'application/octet-stream';
  const confidence = typeof input.confidence === 'number'
    ? Math.max(0, Math.min(1, input.confidence))
    : 0.5;

  await mkdir(storageRoot, { recursive: true });
  await writeFile(storagePath, input.content);

  const db = getDb();
  const rows = await db.query<ArtifactRow>(
    `
    INSERT INTO artifacts (
      artifact_id, node_id, session_id, task_run_id, trace_id, request_id,
      workspace_root, original_path, path_policy, storage_path, size_bytes,
      checksum, checksum_algorithm, content_type, status, confidence,
      metadata_json, updated_at, deleted_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'sha256', $13, 'draft', $14, $15::jsonb, now(), NULL)
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
          status = EXCLUDED.status,
          confidence = EXCLUDED.confidence,
          metadata_json = EXCLUDED.metadata_json,
          updated_at = now(),
          deleted_at = NULL
    RETURNING *
  `,
    [
      artifactId, nodeId,
      normalizeOptionalString(input.sessionId) ?? null,
      normalizeOptionalString(input.taskRunId) ?? null,
      normalizeOptionalString(input.traceId) ?? null,
      normalizeOptionalString(input.requestId) ?? null,
      normalizeOptionalString(input.workspaceRoot) ?? null,
      normalizeOptionalString(input.path) ?? null,
      pathPolicy, storagePath,
      input.content.byteLength, checksum, contentType, confidence,
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

/**
 * Update an artifact's status and/or confidence.
 *
 * Hard constraint: 'confirmed' can only be set when `isHumanAttestation` is true.
 * Agent-caller code must pass `isHumanAttestation: false` (or omit it).
 * This enforces the "AI can never write confirmed" principle.
 */
export async function updateArtifactStatus(
  artifactId: string,
  update: { status?: import('./types.js').ArtifactStatus; confidence?: number; reason?: string },
  opts: { isHumanAttestation: boolean } = { isHumanAttestation: false },
): Promise<ArtifactRecord | null> {
  await ensureArtifactStore();
  const existing = await loadArtifact(artifactId);
  if (!existing) return null;

  if (update.status === 'confirmed' && !opts.isHumanAttestation) {
    throw new Error(
      'Artifact status "confirmed" requires human attestation. ' +
      'AI agents cannot set this status. Pass isHumanAttestation: true only from operator-facing endpoints.',
    );
  }

  if (update.status !== undefined && !AGENT_WRITABLE_STATUSES.includes(update.status) && !opts.isHumanAttestation) {
    throw new Error(
      `Artifact status "${update.status}" is not writable by AI agents. ` +
      `Agent-writable statuses: ${AGENT_WRITABLE_STATUSES.join(', ')}`,
    );
  }

  const confidence = update.confidence !== undefined
    ? Math.max(0, Math.min(1, update.confidence))
    : undefined;

  const db = getDb();
  const rows = await db.query<ArtifactRow>(
    `
    UPDATE artifacts
    SET status = COALESCE($2, status),
        confidence = COALESCE($3, confidence),
        updated_at = now()
    WHERE artifact_id = $1
    RETURNING *
  `,
    [existing.artifactId, update.status ?? null, confidence ?? null],
  );

  const record = rowToArtifact(assertRow(rows.rows[0]));
  // Only emit session event when a session context exists
  if (record.sessionId) {
    await appendSessionEvent({
      sessionId: record.sessionId,
      nodeId: record.nodeId,
      requestId: record.requestId,
      traceId: record.traceId,
      type: 'artifact.status_updated',
      source: opts.isHumanAttestation ? 'operator' : 'agent',
      payload: {
        artifactId: record.artifactId,
        previousStatus: existing.status,
        newStatus: record.status,
        previousConfidence: existing.confidence,
        newConfidence: record.confidence,
        reason: update.reason ?? null,
      },
    });
  }
  return record;
}
