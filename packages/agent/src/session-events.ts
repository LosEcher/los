/**
 * @los/agent/session-events — Internal append-only session event ledger.
 *
 * Stores raw execution evidence for los-owned runs:
 * - user/model/tool transitions
 * - cache/model/tool metadata
 * - compact projections for observability
 *
 * This is the durable base layer for later JS/SQL query surfaces.
 */

import { getDb, type DbTransactionClient } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';

const log = getLogger('agent');

export interface SessionEventUsage {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  totalTokens: number;
}

export type SessionEventVisibility = 'public' | 'audit' | 'internal';

/** Classify an event type into its visibility tier.
 *  - public: user-facing events (tool calls, model responses, task lifecycle)
 *  - audit:  observability bookmarks (session started, tool catalog, governance)
 *  - internal: state-machine transitions that duplicate richer tool and task events
 */
export function sessionEventVisibility(type: string): SessionEventVisibility {
  if (type.startsWith('tool_call_state.')) return 'internal';
  if (type.startsWith('tool.pre_action.') || type.startsWith('tool.gate.')) return 'audit';
  // Governance sweep/job lifecycle is operator audit, not user-facing chat noise.
  if (type.startsWith('governance.')) return 'audit';
  if (type.startsWith('coordinator.')) return 'audit';
  if (type.startsWith('kernel.')) return 'audit';
  if (type === 'session.started' || type === 'session.completed' ||
      type === 'tool.catalog' || type === 'model.turn.started') {
    return 'audit';
  }
  return 'public';
}

export interface ListSessionEventsOptions {
  /** When false, omit internal-tier rows. Default true (full ledger for tests/SSE). */
  includeInternal?: boolean;
}

export interface SessionEventRecord {
  id: number;
  sessionId: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  nodeId?: string;
  requestId?: string;
  traceId?: string;
  turn: number;
  type: string;
  source: string;
  model?: string;
  toolName?: string;
  cacheKey?: string;
  cacheHit?: boolean;
  usage?: SessionEventUsage;
  parentEventId?: number;
  payload: Record<string, unknown>;
  visibility: SessionEventVisibility;
  createdAt: string;
}

export interface SessionEventWrite {
  sessionId: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  nodeId?: string;
  requestId?: string;
  traceId?: string;
  turn?: number;
  type: string;
  source?: string;
  model?: string;
  toolName?: string;
  cacheKey?: string;
  cacheHit?: boolean;
  usage?: Partial<SessionEventUsage>;
  parentEventId?: number;
  visibility?: SessionEventVisibility;
  payload?: Record<string, unknown>;
}

export interface SessionObservability {
  sessionId: string;
  eventCount: number;
  turnCount: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  totalUsage: SessionEventUsage;
  cache: {
    status: 'observed' | 'reserved';
    eventCount: number;
    hitCount: number;
    missCount: number;
    hitRate: number;
    keys: string[];
  };
  tools: {
    status: 'observed' | 'reserved';
    count: number;
    names: string[];
  };
  models: {
    status: 'observed' | 'reserved';
    count: number;
    names: string[];
  };
  projections: {
    externalSources: { status: 'reserved'; adapters: string[] };
    cacheArtifacts: { status: 'reserved'; notes: string };
    modelPolicy: { status: 'reserved'; notes: string };
    toolPolicy: { status: 'reserved'; notes: string };
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session_events (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  tenant_id TEXT,
  project_id TEXT,
  user_id TEXT,
  node_id TEXT,
  request_id TEXT,
  trace_id TEXT,
  turn INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'los',
  model TEXT,
  tool_name TEXT,
  cache_key TEXT,
  cache_hit BOOLEAN,
  usage_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  parent_event_id BIGINT,
  visibility TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE session_events ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE session_events ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE session_events ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE session_events ADD COLUMN IF NOT EXISTS node_id TEXT;
ALTER TABLE session_events ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE session_events ADD COLUMN IF NOT EXISTS trace_id TEXT;
ALTER TABLE session_events ADD COLUMN IF NOT EXISTS visibility TEXT;

CREATE INDEX IF NOT EXISTS idx_session_events_session_id ON session_events(session_id);
CREATE INDEX IF NOT EXISTS idx_session_events_tenant_project ON session_events(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_session_events_node_id ON session_events(node_id);
CREATE INDEX IF NOT EXISTS idx_session_events_request_id ON session_events(request_id);
CREATE INDEX IF NOT EXISTS idx_session_events_trace_id ON session_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_session_events_session_turn ON session_events(session_id, turn, id);
CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(type);
CREATE INDEX IF NOT EXISTS idx_session_events_source ON session_events(source);
CREATE INDEX IF NOT EXISTS idx_session_events_model ON session_events(model);
CREATE INDEX IF NOT EXISTS idx_session_events_tool_name ON session_events(tool_name);
CREATE INDEX IF NOT EXISTS idx_session_events_cache_key ON session_events(cache_key);
CREATE INDEX IF NOT EXISTS idx_session_events_created ON session_events(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_events_operator_control_consumed
  ON session_events(session_id, parent_event_id)
  WHERE type = 'operator.control.consumed' AND parent_event_id IS NOT NULL;
`;

let _initialized = false;

export async function ensureSessionEventStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(SCHEMA);
  _initialized = true;
}

export async function appendSessionEvent(
  input: SessionEventWrite,
  options: { client?: DbTransactionClient; notify?: boolean } = {},
): Promise<SessionEventRecord> {
  await ensureSessionEventStore();
  const sql = `
    INSERT INTO session_events (
      session_id, tenant_id, project_id, user_id, node_id, request_id, trace_id,
      turn, type, source, model, tool_name, cache_key, cache_hit,
      usage_json, payload_json, parent_event_id, visibility
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17, $18)
    RETURNING *
  `;
  const params = [
      input.sessionId,
      input.tenantId ?? null,
      input.projectId ?? null,
      input.userId ?? null,
      input.nodeId ?? null,
      input.requestId ?? null,
      input.traceId ?? null,
      input.turn ?? 0,
      input.type,
      input.source ?? 'los',
      input.model ?? null,
      input.toolName ?? null,
      input.cacheKey ?? null,
      input.cacheHit ?? null,
      JSON.stringify(normalizeUsage(input.usage)),
      JSON.stringify(redactValue(input.payload ?? {})),
      input.parentEventId ?? null,
      input.visibility ?? sessionEventVisibility(input.type),
  ];
  const rows = options.client
    ? await options.client.query<SessionEventRow>(sql, params)
    : await getDb().query<SessionEventRow>(sql, params);
  const row = rows.rows[0];
  if (!row) {
    throw new Error('Failed to append session event');
  }
  const record = rowToSessionEvent(row);

  if (options.notify !== false) await notifySessionEvent(record);
  return record;
}

export async function notifySessionEvent(record: SessionEventRecord): Promise<void> {
  try {
    await getDb().notify('session_events', JSON.stringify({
      session_id: record.sessionId,
      event_id: record.id,
      type: record.type,
    }));
  } catch {
    // Non-critical
  }
}

export async function appendSessionEvents(inputs: SessionEventWrite[]): Promise<SessionEventRecord[]> {
  if (inputs.length === 0) return [];
  if (inputs.length === 1) return [await appendSessionEvent(inputs[0])];

  await ensureSessionEventStore();
  const db = getDb();

  const columns = [
    'session_id', 'tenant_id', 'project_id', 'user_id', 'node_id', 'request_id', 'trace_id',
    'turn', 'type', 'source', 'model', 'tool_name', 'cache_key', 'cache_hit',
    'usage_json', 'payload_json', 'parent_event_id', 'visibility',
  ];

  // Build a single multi-row INSERT ... VALUES ... RETURNING *
  const valuePlaceholders: string[] = [];
  const params: unknown[] = [];
  const colCount = columns.length;

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const base = i * colCount;
    valuePlaceholders.push(`(${columns.map((_, j) => `$${base + j + 1}`).join(', ')})`);
    params.push(
      input.sessionId,
      input.tenantId ?? null,
      input.projectId ?? null,
      input.userId ?? null,
      input.nodeId ?? null,
      input.requestId ?? null,
      input.traceId ?? null,
      input.turn ?? 0,
      input.type,
      input.source ?? 'los',
      input.model ?? null,
      input.toolName ?? null,
      input.cacheKey ?? null,
      input.cacheHit ?? null,
      JSON.stringify(normalizeUsage(input.usage)),
      JSON.stringify(redactValue(input.payload ?? {})),
      input.parentEventId ?? null,
      input.visibility ?? sessionEventVisibility(input.type),
    );
  }

  const sql = `
    INSERT INTO session_events (${columns.join(', ')})
    VALUES ${valuePlaceholders.join(', ')}
    RETURNING *
  `;

  const rows = await db.query<SessionEventRow>(sql, params);
  const records = rows.rows.map(rowToSessionEvent);

  // Batch notify: emit one aggregated notification per session
  const sessionIds = new Set(records.map(r => r.sessionId));
  for (const sid of sessionIds) {
    const eventsForSession = records.filter(r => r.sessionId === sid);
    try {
      await db.notify('session_events', JSON.stringify({
        session_id: sid,
        count: eventsForSession.length,
        first_event_id: eventsForSession[0].id,
        last_event_id: eventsForSession[eventsForSession.length - 1].id,
        types: [...new Set(eventsForSession.map(r => r.type))],
      }));
    } catch {
      // Non-critical
    }
  }

  return records;
}

export async function listSessionEvents(
  sessionId: string,
  limit = 200,
  opts?: ListSessionEventsOptions,
): Promise<SessionEventRecord[]> {
  await ensureSessionEventStore();
  const db = getDb();
  const includeInternal = opts?.includeInternal !== false;
  const rows = await db.query<SessionEventRow>(
    includeInternal
      ? 'SELECT * FROM session_events WHERE session_id = $1 ORDER BY id ASC LIMIT $2'
      : `SELECT * FROM session_events
         WHERE session_id = $1
           AND coalesce(visibility, 'public') <> 'internal'
         ORDER BY id ASC LIMIT $2`,
    [sessionId, limit],
  );
  return rows.rows.map(rowToSessionEvent);
}

export async function loadSessionEvent(sessionId: string, eventId: number): Promise<SessionEventRecord | null> {
  await ensureSessionEventStore();
  const db = getDb();
  const rows = await db.query<SessionEventRow>(
    'SELECT * FROM session_events WHERE session_id = $1 AND id = $2 LIMIT 1',
    [sessionId, eventId],
  );
  return rows.rows[0] ? rowToSessionEvent(rows.rows[0]) : null;
}

export async function listRecentSessionEvents(sessionId: string, limit = 50): Promise<SessionEventRecord[]> {
  await ensureSessionEventStore();
  const db = getDb();
  const rows = await db.query<SessionEventRow>(
    `
    SELECT *
    FROM session_events
    WHERE session_id = $1
    ORDER BY id DESC
    LIMIT $2
  `,
    [sessionId, limit],
  );
  return rows.rows.reverse().map(rowToSessionEvent);
}

export async function listSessionEventsSince(
  sessionId: string,
  sinceId: number,
  limit = 200,
  opts?: ListSessionEventsOptions,
): Promise<SessionEventRecord[]> {
  await ensureSessionEventStore();
  const db = getDb();
  const includeInternal = opts?.includeInternal !== false;
  const rows = await db.query<SessionEventRow>(
    includeInternal
      ? `
    SELECT *
    FROM session_events
    WHERE session_id = $1 AND id > $2
    ORDER BY id ASC
    LIMIT $3
  `
      : `
    SELECT *
    FROM session_events
    WHERE session_id = $1 AND id > $2
      AND coalesce(visibility, 'public') <> 'internal'
    ORDER BY id ASC
    LIMIT $3
  `,
    [sessionId, sinceId, limit],
  );
  return rows.rows.map(rowToSessionEvent);
}

export async function getSessionObservability(sessionId: string): Promise<SessionObservability> {
  const events = await listSessionEvents(sessionId, 10000);
  return projectSessionObservability(sessionId, events);
}

export function projectSessionObservability(
  sessionId: string,
  events: SessionEventRecord[],
): SessionObservability {
  const toolNames = new Set<string>();
  const modelNames = new Set<string>();
  const cacheKeys = new Set<string>();
  const turnSet = new Set<number>();
  const usage = emptyUsage();
  let firstEventAt: string | null = null;
  let lastEventAt: string | null = null;
  let cacheEventCount = 0;
  let cacheHitCount = 0;
  let cacheMissCount = 0;

  for (const event of events) {
    if (event.turn > 0) turnSet.add(event.turn);
    if (firstEventAt === null || event.createdAt < firstEventAt) firstEventAt = event.createdAt;
    if (lastEventAt === null || event.createdAt > lastEventAt) lastEventAt = event.createdAt;
    if (event.model) modelNames.add(event.model);
    if (event.toolName) toolNames.add(event.toolName);
    if (event.cacheKey) cacheKeys.add(event.cacheKey);

    if (event.type === 'model.response' || event.type === 'model.turn.started') {
      if (event.usage) {
        usage.promptTokens += event.usage.promptTokens ?? 0;
        usage.completionTokens += event.usage.completionTokens ?? 0;
        usage.cacheHitTokens += event.usage.cacheHitTokens ?? 0;
        usage.cacheMissTokens += event.usage.cacheMissTokens ?? 0;
        usage.totalTokens += event.usage.totalTokens ?? 0;
      }
      if (event.type === 'model.response') {
        if (event.cacheKey) cacheKeys.add(event.cacheKey);
      }
    }
    if (event.cacheKey) {
      cacheEventCount += 1;
      if (event.cacheHit === true) cacheHitCount += 1;
      if (event.cacheHit === false) cacheMissCount += 1;
    }
  }

  const cacheObserved = cacheEventCount > 0 || usage.cacheHitTokens > 0 || usage.cacheMissTokens > 0;
  return {
    sessionId,
    eventCount: events.length,
    turnCount: turnSet.size,
    firstEventAt,
    lastEventAt,
    totalUsage: usage,
    cache: {
      status: cacheObserved ? 'observed' : 'reserved',
      eventCount: cacheEventCount,
      hitCount: cacheHitCount,
      missCount: cacheMissCount,
      hitRate: cacheHitCount + cacheMissCount > 0 ? cacheHitCount / (cacheHitCount + cacheMissCount) : 0,
      keys: [...cacheKeys].sort(),
    },
    tools: {
      status: toolNames.size > 0 ? 'observed' : 'reserved',
      count: toolNames.size,
      names: [...toolNames].sort(),
    },
    models: {
      status: modelNames.size > 0 ? 'observed' : 'reserved',
      count: modelNames.size,
      names: [...modelNames].sort(),
    },
    projections: {
      externalSources: {
        status: 'reserved',
        adapters: ['codex-jsonl', 'claude-jsonl', 'other-jsonl'],
      },
      cacheArtifacts: {
        status: 'reserved',
        notes: 'cache keys and hit/miss counters are recorded now; blob/cache artifact materialization stays for a later adapter layer.',
      },
      modelPolicy: {
        status: 'reserved',
        notes: 'model routing and model-specific optimization hooks are surfaced as event metadata for later policy projection.',
      },
      toolPolicy: {
        status: 'reserved',
        notes: 'tool selection, tool names, and tool result summaries are preserved for later ranking and audit layers.',
      },
    },
  };
}

type SessionEventRow = {
  id: number | string;
  session_id: string;
  tenant_id: string | null;
  project_id: string | null;
  user_id: string | null;
  node_id: string | null;
  request_id: string | null;
  trace_id: string | null;
  turn: number | string;
  type: string;
  source: string;
  model: string | null;
  tool_name: string | null;
  cache_key: string | null;
  cache_hit: boolean | null;
  usage_json: unknown;
  payload_json: unknown;
  parent_event_id: number | string | null;
  visibility: string | null;
  created_at: Date | string;
};

function rowToSessionEvent(row: SessionEventRow): SessionEventRecord {
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    tenantId: row.tenant_id ?? undefined,
    projectId: row.project_id ?? undefined,
    userId: row.user_id ?? undefined,
    nodeId: row.node_id ?? undefined,
    requestId: row.request_id ?? undefined,
    traceId: row.trace_id ?? undefined,
    turn: Number(row.turn),
    type: row.type,
    source: row.source,
    model: row.model ?? undefined,
    toolName: row.tool_name ?? undefined,
    cacheKey: row.cache_key ?? undefined,
    cacheHit: row.cache_hit ?? undefined,
    usage: normalizeUsage(row.usage_json),
    parentEventId: row.parent_event_id == null ? undefined : Number(row.parent_event_id),
    payload: normalizeJsonObject(row.payload_json),
    visibility: (row.visibility as SessionEventVisibility) ?? sessionEventVisibility(row.type),
    createdAt: toIsoString(row.created_at),
  };
}

function normalizeUsage(value: unknown): SessionEventUsage {
  const src = normalizeJsonObject(value);
  return {
    promptTokens: Number(src.promptTokens ?? src.prompt_tokens ?? 0),
    completionTokens: Number(src.completionTokens ?? src.completion_tokens ?? 0),
    cacheHitTokens: Number(src.cacheHitTokens ?? src.cache_hit_tokens ?? 0),
    cacheMissTokens: Number(src.cacheMissTokens ?? src.cache_miss_tokens ?? 0),
    totalTokens: Number(src.totalTokens ?? src.total_tokens ?? 0),
  };
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
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

function emptyUsage(): SessionEventUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    totalTokens: 0,
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

const SECRET_KEY_RE = /(secret|token|password|passphrase|api[-_]?key|authorization|cookie|credential|passwd|pwd)/i;

function redactValue(value: unknown, key: string | null = null): unknown {
  if (Array.isArray(value)) return value.map(item => redactValue(item));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = redactValue(childValue, childKey);
    }
    return out;
  }
  if (typeof value === 'string') {
    if ((key && SECRET_KEY_RE.test(key)) || /^Bearer\s+/i.test(value)) return '[redacted]';
  }
  return value;
}
