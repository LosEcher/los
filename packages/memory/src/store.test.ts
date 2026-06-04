/**
 * @los/memory/store — unit tests for row mapping and JSON normalization helpers.
 *
 * DB-dependent functions (addObservation/searchObservations/getStats etc.)
 * require a running PostgreSQL instance. Tests for those go in store.integration.test.ts.
 */
import assert from 'node:assert';
import { describe, it } from 'node:test';

// ── rowToObservation ────────────────────────────────────

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

interface Observation {
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

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

describe('rowToObservation', () => {
  const baseRow: ObservationRow = {
    id: 1,
    title: 'Test observation',
    summary: 'Summary text',
    kind: 'fact',
    tags_json: '["code-scan","incident"]',
    content: 'Full content here',
    metadata_json: '{"severity":"high"}',
    source: 'agent',
    session_id: 'session-1',
    tenant_id: 'tenant-1',
    project_id: 'project-1',
    user_id: 'user-1',
    node_id: 'node-1',
    request_id: 'req-1',
    trace_id: 'trace-1',
    created_at: '2026-06-04T12:00:00.000Z',
    updated_at: new Date('2026-06-04T13:00:00.000Z'),
  };

  it('maps all fields correctly from a complete row', () => {
    const obs = rowToObservation(baseRow);
    assert.strictEqual(obs.id, 1);
    assert.strictEqual(obs.title, 'Test observation');
    assert.strictEqual(obs.summary, 'Summary text');
    assert.strictEqual(obs.kind, 'fact');
    assert.deepStrictEqual(obs.tags, ['code-scan', 'incident']);
    assert.strictEqual(obs.content, 'Full content here');
    assert.deepStrictEqual(obs.metadata, { severity: 'high' });
    assert.strictEqual(obs.source, 'agent');
    assert.strictEqual(obs.sessionId, 'session-1');
    assert.strictEqual(obs.tenantId, 'tenant-1');
    assert.strictEqual(obs.projectId, 'project-1');
    assert.strictEqual(obs.userId, 'user-1');
    assert.strictEqual(obs.nodeId, 'node-1');
    assert.strictEqual(obs.requestId, 'req-1');
    assert.strictEqual(obs.traceId, 'trace-1');
    assert.strictEqual(obs.createdAt, '2026-06-04T12:00:00.000Z');
    assert.strictEqual(obs.updatedAt, '2026-06-04T13:00:00.000Z');
  });

  it('handles null tenant/project/user/node/request/trace ids', () => {
    const row: ObservationRow = {
      ...baseRow,
      tenant_id: null, project_id: null, user_id: null,
      node_id: null, request_id: null, trace_id: null, session_id: null,
    };
    const obs = rowToObservation(row);
    assert.strictEqual(obs.sessionId, undefined);
    assert.strictEqual(obs.tenantId, undefined);
    assert.strictEqual(obs.projectId, undefined);
    assert.strictEqual(obs.userId, undefined);
    assert.strictEqual(obs.nodeId, undefined);
    assert.strictEqual(obs.requestId, undefined);
    assert.strictEqual(obs.traceId, undefined);
  });

  it('converts numeric id from string', () => {
    const row: ObservationRow = { ...baseRow, id: '42' };
    const obs = rowToObservation(row);
    assert.strictEqual(obs.id, 42);
  });

  it('handles already-parsed tags_json array', () => {
    const row: ObservationRow = { ...baseRow, tags_json: ['a', 'b'] };
    const obs = rowToObservation(row);
    assert.deepStrictEqual(obs.tags, ['a', 'b']);
  });

  it('handles already-parsed metadata_json object', () => {
    const row: ObservationRow = { ...baseRow, metadata_json: { count: 5 } };
    const obs = rowToObservation(row);
    assert.deepStrictEqual(obs.metadata, { count: 5 });
  });

  it('handles empty tags_json', () => {
    const row: ObservationRow = { ...baseRow, tags_json: '[]' };
    const obs = rowToObservation(row);
    assert.deepStrictEqual(obs.tags, []);
  });
});

describe('normalizeJsonArray (memory)', () => {
  it('returns string array from number array', () => {
    assert.deepStrictEqual(normalizeJsonArray([1, 2, 3] as unknown), ['1', '2', '3']);
  });

  it('returns string array from JSON string array', () => {
    assert.deepStrictEqual(normalizeJsonArray('["a","b"]'), ['a', 'b']);
  });

  it('returns empty array for non-array JSON', () => {
    assert.deepStrictEqual(normalizeJsonArray('{"a":1}'), []);
  });

  it('returns empty array for invalid JSON', () => {
    assert.deepStrictEqual(normalizeJsonArray('not json'), []);
  });

  it('returns empty array for non-string non-array', () => {
    assert.deepStrictEqual(normalizeJsonArray(42), []);
    assert.deepStrictEqual(normalizeJsonArray(null), []);
  });
});
