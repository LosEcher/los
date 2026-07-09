/**
 * @los/memory/entity-store — Knowledge Graph entity retrieval.
 *
 * Extracted from store.ts to keep it under 600 lines.
 * These functions query entity metadata across observations.
 */

import { getDb } from '@los/infra/db';
import { ensureMemoryStore, type Observation, toIsoString } from './store.js';

export interface EntityNode {
  entityId: string;
  entityType: string;
  observationCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface EntityCooccurrence {
  entityId: string;
  entityType: string;
  cooccurrenceCount: number;
}

export interface EntitySearchOptions {
  entityType?: string;
  limit?: number;
  tenantId?: string;
  projectId?: string;
  minObservations?: number;
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

function normalizeJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(v => String(v));
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(v => String(v)) : []; }
    catch { return []; }
  }
  return [];
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; }
    catch { return {}; }
  }
  return {};
}

function rowToObservation(row: ObservationRow): Observation {
  return {
    id: Number(row.id), title: row.title, summary: row.summary, kind: row.kind,
    tags: normalizeJsonArray(row.tags_json), content: row.content,
    metadata: normalizeJsonObject(row.metadata_json), source: row.source,
    sessionId: row.session_id ?? undefined, tenantId: row.tenant_id ?? undefined,
    projectId: row.project_id ?? undefined, userId: row.user_id ?? undefined,
    nodeId: row.node_id ?? undefined, requestId: row.request_id ?? undefined,
    traceId: row.trace_id ?? undefined, createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

/**
 * List distinct entities observed across observations.
 * Entities are extracted from metadata_json -> 'entities' (JSON array of
 * {id, type} objects). Optionally filter by entityType and scope.
 */
export async function listEntities(opts?: EntitySearchOptions): Promise<EntityNode[]> {
  await ensureMemoryStore();
  const db = getDb();
  const limit = opts?.limit ?? 50;
  const params: unknown[] = [];
  const clauses: string[] = [];

  if (opts?.entityType) {
    params.push(opts.entityType);
    clauses.push(`EXISTS (
      SELECT 1 FROM jsonb_array_elements(
        CASE jsonb_typeof(metadata_json->'entities')
          WHEN 'array' THEN metadata_json->'entities'
          ELSE '[]'::jsonb
      ) AS e
    )`);
  }
  if (opts?.tenantId) { params.push(opts.tenantId); clauses.push(`tenant_id = $${params.length}`); }
  if (opts?.projectId) { params.push(opts.projectId); clauses.push(`project_id = $${params.length}`); }
  if (opts?.minObservations) { params.push(opts.minObservations); clauses.push(`(metadata_json->>'entityCount')::int >= $${params.length}`); }

  params.push(limit);
  const allClauses = [...clauses, `metadata_json->>'sourceEntity' IS NOT NULL`];
  const where = `WHERE ${allClauses.join(' AND ')}`;

  const rows = await db.query<{
    entity_id: string; entity_type: string; obs_count: string; first_seen: Date; last_seen: Date;
  }>(
    `SELECT metadata_json->>'sourceEntity' AS entity_id,
            metadata_json->>'entityType' AS entity_type,
            COUNT(*)::text AS obs_count,
            MIN(created_at) AS first_seen,
            MAX(created_at) AS last_seen
     FROM observations ${where}
     GROUP BY metadata_json->>'sourceEntity', metadata_json->>'entityType'
     ORDER BY obs_count DESC LIMIT $${params.length}`,
    params,
  );

  return rows.rows.map(r => ({
    entityId: r.entity_id, entityType: r.entity_type ?? 'unknown',
    observationCount: Number(r.obs_count), firstSeenAt: toIsoString(r.first_seen),
    lastSeenAt: toIsoString(r.last_seen),
  }));
}

/**
 * Find observations related to a specific entity (entity-centric search).
 */
export async function findRelatedObservations(
  entityId: string,
  opts?: { tenantId?: string; projectId?: string; limit?: number },
): Promise<Observation[]> {
  await ensureMemoryStore();
  const db = getDb();
  const limit = opts?.limit ?? 20;
  const params: unknown[] = [entityId];
  const clauses: string[] = [`metadata_json->>'sourceEntity' = $1`];

  if (opts?.tenantId) { params.push(opts.tenantId); clauses.push(`tenant_id = $${params.length}`); }
  if (opts?.projectId) { params.push(opts.projectId); clauses.push(`project_id = $${params.length}`); }

  params.push(limit);
  const rows = await db.query<ObservationRow>(
    `SELECT * FROM observations WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(rowToObservation);
}

/**
 * Find entities that co-occur with the given entity across observations.
 */
export async function findCooccurringEntities(
  entityId: string,
  opts?: { limit?: number; minCooccurrences?: number; tenantId?: string; projectId?: string },
): Promise<EntityCooccurrence[]> {
  await ensureMemoryStore();
  const db = getDb();
  const limit = opts?.limit ?? 20;
  const minCo = opts?.minCooccurrences ?? 1;

  const params: unknown[] = [entityId];
  const clauses: string[] = [
    `o.metadata_json->>'sourceEntity' != $1`,
    `o2.metadata_json->>'sourceEntity' = $1`,
  ];
  if (opts?.tenantId) { params.push(opts.tenantId); }
  if (opts?.projectId) { params.push(opts.projectId); clauses.push(`o.project_id = $${params.length}`); }

  params.push(minCo, limit);
  const rows = await db.query<{ entity_id: string; entity_type: string; co_count: string }>(
    `SELECT o.metadata_json->>'sourceEntity' AS entity_id,
            o.metadata_json->>'entityType' AS entity_type,
            COUNT(DISTINCT o.session_id)::text AS co_count
     FROM observations o
     JOIN observations o2 ON o.session_id = o2.session_id
       AND o2.metadata_json->>'sourceEntity' = $1
     WHERE ${clauses.join(' AND ')}
     GROUP BY o.metadata_json->>'sourceEntity', o.metadata_json->>'entityType'
     HAVING COUNT(DISTINCT o.session_id) >= $${params.length - 1}
     ORDER BY co_count DESC LIMIT $${params.length}`,
    params,
  );

  return rows.rows.map(r => ({
    entityId: r.entity_id, entityType: r.entity_type ?? 'unknown',
    cooccurrenceCount: Number(r.co_count),
  }));
}
