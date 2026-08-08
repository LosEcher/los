/**
 * @los/memory — Durable memory ledger on PostgreSQL.
 *
 * Single-node los deployments use the same schema as mesh deployments.
 * The node count changes; the persistence model does not.
 */

import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import { getConfig } from '@los/infra/config';
// Entity store functions extracted to entity-store.ts to keep this file under 600 lines.
export { listEntities, findRelatedObservations, findCooccurringEntities } from './entity-store.js';
export type { EntityNode, EntityCooccurrence, EntitySearchOptions } from './entity-store.js';

const log = getLogger('memory');

export interface Observation {
  id: number;
  title: string;
  summary: string;
  kind: string;
  tags: string[];
  content: string;
  metadata: Record<string, unknown>;
  source: string;
  sessionId?: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  nodeId?: string;
  requestId?: string;
  traceId?: string;
  createdAt: string;
  updatedAt: string;
}

import type { ObserverType } from '../types.js';
import {
  validateMemoryWrite,
  detectPoisoning,
  buildPoisonFlag,
  type MemoryWriteViolation,
} from './write-gate.js';

/** Thrown when a memory write fails the structural/source gate. */
export class MemoryWriteError extends Error {
  readonly violations: MemoryWriteViolation[];
  constructor(violations: MemoryWriteViolation[]) {
    super(`Memory write rejected: ${violations.map(v => `${v.field}: ${v.message}`).join('; ')}`);
    this.name = 'MemoryWriteError';
    this.violations = violations;
  }
}

/** Type guard for MemoryWriteError (wiring-friendly: called with parens). */
export function isMemoryWriteError(err: unknown): err is MemoryWriteError {
  return err instanceof MemoryWriteError;
}

/** Dedupe key format: alphanumeric + : _ - .  only, 1-128 chars (slug-safe). */
const DEDUPE_KEY_RE = /^[a-zA-Z0-9:_\-.]+$/;

export interface MemoryStats {
  totalObservations: number;
  byKind: Record<string, number>;
  bySource: Record<string, number>;
  byScope: Record<string, number>;
  byLayer: Record<string, number>;
  archived: number;
  /** Observations written in the last 24 hours */
  recentWrites24h: number;
  /** Observations read (via getObservation / searchObservations) in the last 24 hours */
  recentReads24h: number;
  /** True when recent reads are < 10% of recent writes (write-dominated memory is a smell). */
  lowReadRatio: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS observations (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'note',
  tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  content TEXT NOT NULL DEFAULT '',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL DEFAULT 'user',
  session_id TEXT,
  tenant_id TEXT,
  project_id TEXT,
  user_id TEXT,
  node_id TEXT,
  request_id TEXT,
  trace_id TEXT,
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(content, '') || ' ' || coalesce(tags_json::text, ''))
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE observations ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS node_id TEXT;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS trace_id TEXT;

CREATE INDEX IF NOT EXISTS idx_obs_kind ON observations(kind);
CREATE INDEX IF NOT EXISTS idx_obs_source ON observations(source);
CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id);
CREATE INDEX IF NOT EXISTS idx_obs_tenant_project ON observations(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_obs_request ON observations(request_id);
CREATE INDEX IF NOT EXISTS idx_obs_trace ON observations(trace_id);
CREATE INDEX IF NOT EXISTS idx_obs_created ON observations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_search ON observations USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_obs_tags_json ON observations USING GIN (tags_json);
CREATE INDEX IF NOT EXISTS idx_obs_scope ON observations ((metadata_json->>'scope'));
CREATE INDEX IF NOT EXISTS idx_obs_memory_layer ON observations ((metadata_json->>'memoryLayer'));
CREATE INDEX IF NOT EXISTS idx_obs_archived ON observations ((metadata_json->>'archived'));
CREATE INDEX IF NOT EXISTS idx_obs_metadata_entity ON observations USING GIN ((metadata_json -> 'entities'));
CREATE INDEX IF NOT EXISTS idx_obs_metadata_entity_type ON observations ((metadata_json ->> 'entityType'));

CREATE OR REPLACE FUNCTION touch_observations_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS obs_touch_updated_at ON observations;
CREATE TRIGGER obs_touch_updated_at
BEFORE UPDATE ON observations
FOR EACH ROW
EXECUTE FUNCTION touch_observations_updated_at();
`;

let _initialized = false;

export async function ensureMemoryStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(SCHEMA);
  _initialized = true;
  log.info('Memory store initialized');
}

/**
 * Validate a dedupe-key slug format. Throws on invalid input.
 *
 * Rules: 1-128 characters; allowed chars: a-z, A-Z, 0-9, :, _, -, .
 * No leading/trailing whitespace.
 */
export function validateDedupeKey(key: string): void {
  if (key.length < 1 || key.length > 128) {
    throw new Error(`dedupeKey must be 1-128 characters, got ${key.length}`);
  }
  if (key !== key.trim()) {
    throw new Error('dedupeKey must not have leading or trailing whitespace');
  }
  if (!DEDUPE_KEY_RE.test(key)) {
    throw new Error(
      `dedupeKey contains invalid characters: "${key}". ` +
      `Allowed: a-z A-Z 0-9 : _ - .`,
    );
  }
}

export async function addObservation(obs: {
  title: string;
  summary?: string;
  kind?: string;
  tags?: string[];
  content?: string;
  metadata?: Record<string, unknown>;
  /** Who/what produced this observation. Stored in metadata.observerType. */
  observerType?: ObserverType;
  source?: string;
  sessionId?: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  nodeId?: string;
  requestId?: string;
  traceId?: string;
}): Promise<Observation> {
  await ensureMemoryStore();
  const db = getDb();

  // Write gate: structural/source constraints before any DB work
  const violations = validateMemoryWrite(obs);
  if (violations.length > 0) {
    throw new MemoryWriteError(violations);
  }

  // Poisoning detection: matching content is written but tagged (keep evidence, attribute)
  const poison = detectPoisoning({ title: obs.title, summary: obs.summary, content: obs.content });

  // Merge observerType into metadata for JSONB storage (no schema change)
  const mergedMetadata = {
    ...(obs.metadata ?? {}),
    ...(poison ? buildPoisonFlag(poison, obs.source) : {}),
    ...(obs.observerType ? { observerType: obs.observerType } : {}),
  };

  // Enforce maxObservations cap
  const maxObs = getConfig().memory.maxObservations;
  const countRow = await db.query<{ cnt: string }>('SELECT count(*)::text as cnt FROM observations');
  const currentCount = parseInt(countRow.rows[0]?.cnt ?? '0', 10);
  if (currentCount >= maxObs) {
    throw new Error(
      `Memory cap reached: ${currentCount}/${maxObs} observations. ` +
      `Archive or delete old observations, or increase maxObservations in config.`,
    );
  }

  const params = [
    obs.title,
    obs.summary ?? '',
    obs.kind ?? 'note',
    JSON.stringify(obs.tags ?? []),
    obs.content ?? '',
    JSON.stringify(mergedMetadata),
    obs.source ?? 'user',
    obs.sessionId ?? null,
    obs.tenantId ?? null,
    obs.projectId ?? null,
    obs.userId ?? null,
    obs.nodeId ?? null,
    obs.requestId ?? null,
    obs.traceId ?? null,
  ];
  const rows = await db.query<ObservationRow>(`
    INSERT INTO observations (
      title, summary, kind, tags_json, content, metadata_json, source, session_id,
      tenant_id, project_id, user_id, node_id, request_id, trace_id
    )
    VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING *
  `, params);
  return rowToObservation(rows.rows[0]);
}

export async function getObservation(id: number): Promise<Observation | null> {
  await ensureMemoryStore();
  const db = getDb();
  const rows = await db.query<ObservationRow>('SELECT * FROM observations WHERE id = $1', [id]);
  return rows.rows[0] ? rowToObservation(rows.rows[0]) : null;
}

export async function updateObservation(
  id: number,
  updates: Partial<Pick<Observation, 'title' | 'summary' | 'kind' | 'tags' | 'content' | 'metadata'>>,
): Promise<Observation | null> {
  await ensureMemoryStore();
  const existing = await getObservation(id);
  if (!existing) return null;

  const db = getDb();
  const title = updates.title ?? existing.title;
  const summary = updates.summary ?? existing.summary;
  const kind = updates.kind ?? existing.kind;
  const tags = updates.tags ?? existing.tags;
  const content = updates.content ?? existing.content;
  const metadata = updates.metadata ?? existing.metadata;

  // Write gate on the merged result (update paths can also smuggle oversized content)
  const violations = validateMemoryWrite({ title, summary, kind, tags, content, metadata, source: existing.source });
  if (violations.length > 0) {
    throw new MemoryWriteError(violations);
  }

  // Poisoning detection on merged content; merge with any existing flag without
  // overwriting an earlier manual flag (manual reason/flaggedAt survive auto-detection).
  const poison = detectPoisoning({ title, summary, content });
  const existingFlag = (metadata.poisonFlag ?? {}) as Record<string, unknown>;
  const autoFlag = poison ? buildPoisonFlag(poison, existing.source).poisonFlag : null;
  const effectiveMetadata = autoFlag
    ? {
        ...metadata,
        poisonFlag: {
          ...existingFlag,
          ...autoFlag,
          reason: existingFlag.reason ?? autoFlag.reason,
          flaggedAt: existingFlag.flaggedAt ?? autoFlag.flaggedAt,
        },
      }
    : metadata;

  const rows = await db.query<ObservationRow>(`
    UPDATE observations
    SET title = $1,
        summary = $2,
        kind = $3,
        tags_json = $4::jsonb,
        content = $5,
        metadata_json = $6::jsonb,
        updated_at = now()
    WHERE id = $7
    RETURNING *
  `, [title, summary, kind, JSON.stringify(tags), content, JSON.stringify(effectiveMetadata), id]);

  return rows.rows[0] ? rowToObservation(rows.rows[0]) : null;
}

/**
 * Idempotent observation write: insert or update based on a caller-provided dedupe key.
 *
 * When `dedupeKey` is provided, this function checks for an existing observation
 * with the same key and updates it in-place (merging content/metadata). Without a
 * dedupe key it behaves like {@link addObservation} (pure INSERT).
 *
 * **Design note**: The current implementation uses check-then-insert/update.
 * A future migration should add `dedupe_key TEXT UNIQUE` to the observations table
 * and replace this with true `ON CONFLICT ... DO UPDATE` for full atomicity.
 *
 * @param dedupeKey — caller-scoped unique key, e.g. `${sessionId}:${kind}:${title}`.
 *   Validated via {@link validateDedupeKey}. When omitted, a new row is always inserted.
 */
export async function upsertObservation(
  obs: {
    title: string;
    summary?: string;
    kind?: string;
    tags?: string[];
    content?: string;
    metadata?: Record<string, unknown>;
    observerType?: ObserverType;
    source?: string;
    sessionId?: string;
    tenantId?: string;
    projectId?: string;
    userId?: string;
    nodeId?: string;
    requestId?: string;
    traceId?: string;
    /**
     * Caller-scoped unique key for deduplication.
     * When provided, existing observations with the same key are updated instead
     * of creating a duplicate. Stored in metadata_json.dedupeKey.
     */
    dedupeKey?: string;
  },
): Promise<Observation> {
  await ensureMemoryStore();
  const db = getDb();

  // Without a dedupe key, fall through to plain insert
  if (!obs.dedupeKey) {
    return addObservation(obs);
  }

  // Validate slug format before any DB work
  validateDedupeKey(obs.dedupeKey);

  // Merge dedupeKey into metadata for storage
  const mergedMetadata = {
    ...(obs.metadata ?? {}),
    dedupeKey: obs.dedupeKey,
    ...(obs.observerType ? { observerType: obs.observerType } : {}),
  };

  // Check for existing observation with the same dedupe key
  const existingRows = await db.query<ObservationRow>(
    `SELECT * FROM observations
     WHERE metadata_json ->> 'dedupeKey' = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [obs.dedupeKey],
  );

  if (existingRows.rows[0]) {
    const existing = rowToObservation(existingRows.rows[0]);
    // Update in-place: merge tags, replace content/summary
    const mergedTags = [
      ...new Set([...(existing.tags ?? []), ...(obs.tags ?? [])]),
    ];
    return (await updateObservation(existing.id, {
      title: obs.title,
      summary: obs.summary ?? existing.summary,
      kind: obs.kind ?? existing.kind,
      tags: mergedTags,
      content: obs.content ?? existing.content,
      metadata: mergedMetadata,
    }))!;
  }

  // No existing match → insert via addObservation (which handles the cap)
  return addObservation({
    title: obs.title,
    summary: obs.summary,
    kind: obs.kind,
    tags: obs.tags,
    content: obs.content,
    metadata: mergedMetadata,
    observerType: obs.observerType,
    source: obs.source,
    sessionId: obs.sessionId,
    tenantId: obs.tenantId,
    projectId: obs.projectId,
    userId: obs.userId,
    nodeId: obs.nodeId,
    requestId: obs.requestId,
    traceId: obs.traceId,
  });
}

export async function deleteObservation(id: number): Promise<boolean> {
  await ensureMemoryStore();
  const db = getDb();
  const rows = await db.query<{ id: number }>('DELETE FROM observations WHERE id = $1 RETURNING id', [id]);
  return rows.rows.length > 0;
}

/**
 * Tag an existing observation as suspicious WITHOUT deleting it — evidence is
 * retained and attributable (poisoning defense: "keep evidence, tag it").
 * Merges into metadata.poisonFlag; the observation remains searchable.
 */
export async function flagObservationAsSuspicious(
  id: number,
  reason: string,
  flaggedBy?: string,
): Promise<Observation | null> {
  await ensureMemoryStore();
  const existing = await getObservation(id);
  if (!existing) return null;
  const prevFlag = (existing.metadata.poisonFlag ?? {}) as Record<string, unknown>;
  const poisonFlag = {
    ...prevFlag,
    flaggedAt: new Date().toISOString(),
    reason,
    ...(flaggedBy ? { flaggedBy } : {}),
  };
  return updateObservation(id, { metadata: { ...existing.metadata, poisonFlag } });
}

export async function searchObservations(query: string, opts?: {
  limit?: number;
  kind?: string;
  source?: string;
  tag?: string;
  scope?: string;
  memoryLayer?: string;
  archived?: boolean;
  sessionId?: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  requestId?: string;
  traceId?: string;
}): Promise<Observation[]> {
  await ensureMemoryStore();
  const db = getDb();

  const limit = opts?.limit ?? 20;
  const params: unknown[] = [];
  const clauses: string[] = [];

  if (query.trim()) {
    params.push(query.trim());
    clauses.push(`search_vector @@ plainto_tsquery('simple', $${params.length})`);
  }
  if (opts?.kind) {
    params.push(opts.kind);
    clauses.push(`kind = $${params.length}`);
  }
  if (opts?.source) {
    params.push(opts.source);
    clauses.push(`source = $${params.length}`);
  }
  if (opts?.tag) {
    params.push(opts.tag);
    clauses.push(`tags_json ? $${params.length}`);
  }
  if (opts?.scope) {
    params.push(opts.scope);
    clauses.push(`metadata_json->>'scope' = $${params.length}`);
  }
  if (opts?.memoryLayer) {
    params.push(opts.memoryLayer);
    clauses.push(`metadata_json->>'memoryLayer' = $${params.length}`);
  }
  if (opts?.archived !== undefined) {
    params.push(String(opts.archived));
    clauses.push(`coalesce(metadata_json->>'archived', 'false') = $${params.length}`);
  }
  if (opts?.sessionId) {
    params.push(opts.sessionId);
    clauses.push(`session_id = $${params.length}`);
  }
  if (opts?.tenantId) {
    params.push(opts.tenantId);
    clauses.push(`tenant_id = $${params.length}`);
  }
  if (opts?.projectId) {
    params.push(opts.projectId);
    clauses.push(`project_id = $${params.length}`);
  }
  if (opts?.userId) {
    params.push(opts.userId);
    clauses.push(`user_id = $${params.length}`);
  }
  if (opts?.requestId) {
    params.push(opts.requestId);
    clauses.push(`request_id = $${params.length}`);
  }
  if (opts?.traceId) {
    params.push(opts.traceId);
    clauses.push(`trace_id = $${params.length}`);
  }

  params.push(limit);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const orderBy = query.trim()
    ? 'ORDER BY ts_rank_cd(search_vector, plainto_tsquery(\'simple\', $1)) DESC, created_at DESC'
    : 'ORDER BY created_at DESC';
  const sql = `SELECT * FROM observations ${where} ${orderBy} LIMIT $${params.length}`;
  const rows = await db.query<ObservationRow>(sql, params);
  return rows.rows.map(rowToObservation);
}

export async function getStats(): Promise<MemoryStats> {
  await ensureMemoryStore();
  const db = getDb();

  const totalRows = await db.query<{ c: string }>('SELECT COUNT(*)::text AS c FROM observations');
  const kindRows = await db.query<{ kind: string; c: string }>('SELECT kind, COUNT(*)::text AS c FROM observations GROUP BY kind');
  const sourceRows = await db.query<{ source: string; c: string }>('SELECT source, COUNT(*)::text AS c FROM observations GROUP BY source');
  const scopeRows = await db.query<{ scope: string; c: string }>(`
    SELECT coalesce(nullif(metadata_json->>'scope', ''), 'unspecified') AS scope, COUNT(*)::text AS c
    FROM observations
    GROUP BY scope
  `);
  const layerRows = await db.query<{ layer: string; c: string }>(`
    SELECT coalesce(nullif(metadata_json->>'memoryLayer', ''), 'unspecified') AS layer, COUNT(*)::text AS c
    FROM observations
    GROUP BY layer
  `);
  const archivedRows = await db.query<{ c: string }>(`
    SELECT COUNT(*)::text AS c
    FROM observations
    WHERE coalesce(metadata_json->>'archived', 'false') = 'true'
  `);

  // 24h sliding-window read/write ratio tracking
  const recentWritesRows = await db.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM observations WHERE created_at > now() - interval '24 hours'`,
  );
  const recentReadsRows = await db.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM observations WHERE updated_at > now() - interval '24 hours'
     AND created_at < updated_at`,
  );

  const recentWrites24h = Number(recentWritesRows.rows[0]?.c ?? 0);
  const recentReads24h = Number(recentReadsRows.rows[0]?.c ?? 0);
  // Low-read alarm: write-heavy memory with fewer than 10% reads is a smell
  const lowReadRatio = recentWrites24h > 10 && recentReads24h < recentWrites24h * 0.1;

  const byKind: Record<string, number> = {};
  for (const r of kindRows.rows) byKind[r.kind] = Number(r.c);

  const bySource: Record<string, number> = {};
  for (const r of sourceRows.rows) bySource[r.source] = Number(r.c);

  const byScope: Record<string, number> = {};
  for (const r of scopeRows.rows) byScope[r.scope] = Number(r.c);

  const byLayer: Record<string, number> = {};
  for (const r of layerRows.rows) byLayer[r.layer] = Number(r.c);

  return {
    totalObservations: Number(totalRows.rows[0]?.c ?? 0),
    byKind,
    bySource,
    byScope,
    byLayer,
    archived: Number(archivedRows.rows[0]?.c ?? 0),
    recentWrites24h,
    recentReads24h,
    lowReadRatio,
  };
}

type ObservationRow = {
  id: number | string;
  title: string;
  summary: string;
  kind: string;
  tags_json: unknown;
  content: string;
  metadata_json: unknown;
  source: string;
  session_id: string | null;
  tenant_id: string | null;
  project_id: string | null;
  user_id: string | null;
  node_id: string | null;
  request_id: string | null;
  trace_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function rowToObservation(row: ObservationRow): Observation {
  return {
    id: Number(row.id),
    title: row.title,
    summary: row.summary,
    kind: row.kind,
    tags: normalizeJsonArray(row.tags_json),
    content: row.content,
    metadata: normalizeJsonObject(row.metadata_json),
    source: row.source,
    sessionId: row.session_id ?? undefined,
    tenantId: row.tenant_id ?? undefined,
    projectId: row.project_id ?? undefined,
    userId: row.user_id ?? undefined,
    nodeId: row.node_id ?? undefined,
    requestId: row.request_id ?? undefined,
    traceId: row.trace_id ?? undefined,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function normalizeJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(v => String(v));
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(v => String(v)) : [];
    } catch {
      return [];
    }
  }
  return [];
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

export function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
