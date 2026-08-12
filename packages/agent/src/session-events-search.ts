/**
 * Cross-session event search (FTS-lite) for operator "what did we decide?" recall.
 * Uses PostgreSQL plainto_tsquery over type/tool/payload text without a permanent
 * generated column so ensure-store stays migration-light.
 */
import { getDb } from '@los/infra/db';
import { ensureSessionEventStore, type SessionEventRecord } from './session-events.js';

export type SessionEventSearchHit = {
  event: SessionEventRecord;
  sessionId: string;
  rank: number;
  snippet: string;
};

function rowToEvent(row: Record<string, unknown>): SessionEventRecord {
  const usage = (row.usage_json ?? {}) as Record<string, unknown>;
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    tenantId: row.tenant_id ? String(row.tenant_id) : undefined,
    projectId: row.project_id ? String(row.project_id) : undefined,
    userId: row.user_id ? String(row.user_id) : undefined,
    nodeId: row.node_id ? String(row.node_id) : undefined,
    requestId: row.request_id ? String(row.request_id) : undefined,
    traceId: row.trace_id ? String(row.trace_id) : undefined,
    turn: Number(row.turn ?? 0),
    type: String(row.type),
    source: String(row.source ?? 'los'),
    model: row.model ? String(row.model) : undefined,
    toolName: row.tool_name ? String(row.tool_name) : undefined,
    cacheKey: row.cache_key ? String(row.cache_key) : undefined,
    cacheHit: typeof row.cache_hit === 'boolean' ? row.cache_hit : undefined,
    usage: {
      promptTokens: Number(usage.promptTokens ?? 0),
      completionTokens: Number(usage.completionTokens ?? 0),
      cacheHitTokens: Number(usage.cacheHitTokens ?? 0),
      cacheMissTokens: Number(usage.cacheMissTokens ?? 0),
      totalTokens: Number(usage.totalTokens ?? 0),
    },
    parentEventId: row.parent_event_id != null ? Number(row.parent_event_id) : undefined,
    payload: (row.payload_json ?? {}) as Record<string, unknown>,
    visibility: (row.visibility as SessionEventRecord['visibility']) ?? 'public',
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

function snippetFrom(event: SessionEventRecord): string {
  const payloadText = JSON.stringify(event.payload ?? {}).slice(0, 180);
  return `${event.type}${event.toolName ? ` ${event.toolName}` : ''} ${payloadText}`.trim();
}

/**
 * Search public/audit session events across sessions.
 * Excludes internal visibility by default.
 */
export async function searchSessionEvents(input: {
  query: string;
  limit?: number;
  sessionId?: string;
  tenantId?: string;
  projectId?: string;
  includeInternal?: boolean;
}): Promise<SessionEventSearchHit[]> {
  const q = input.query.trim();
  if (!q) return [];
  await ensureSessionEventStore();
  const db = getDb();
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const params: unknown[] = [q];
  const clauses: string[] = [
    `to_tsvector('simple', coalesce(type,'') || ' ' || coalesce(tool_name,'') || ' ' || coalesce(payload_json::text,'')) @@ plainto_tsquery('simple', $1)`,
  ];

  if (!input.includeInternal) {
    clauses.push(`(visibility IS NULL OR visibility <> 'internal')`);
  }
  if (input.sessionId) {
    params.push(input.sessionId);
    clauses.push(`session_id = $${params.length}`);
  }
  if (input.tenantId) {
    params.push(input.tenantId);
    clauses.push(`(tenant_id IS NULL OR tenant_id = $${params.length})`);
  }
  if (input.projectId) {
    params.push(input.projectId);
    clauses.push(`(project_id IS NULL OR project_id = $${params.length})`);
  }

  params.push(limit);
  const sql = `
    SELECT *,
      ts_rank_cd(
        to_tsvector('simple', coalesce(type,'') || ' ' || coalesce(tool_name,'') || ' ' || coalesce(payload_json::text,'')),
        plainto_tsquery('simple', $1)
      ) AS rank
    FROM session_events
    WHERE ${clauses.join(' AND ')}
    ORDER BY rank DESC, created_at DESC
    LIMIT $${params.length}
  `;
  const rows = await db.query<Record<string, unknown>>(sql, params);
  return rows.rows.map(row => {
    const event = rowToEvent(row);
    return {
      event,
      sessionId: event.sessionId,
      rank: Number(row.rank ?? 0),
      snippet: snippetFrom(event),
    };
  });
}
