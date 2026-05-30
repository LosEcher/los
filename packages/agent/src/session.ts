/**
 * @los/agent/session — Agent session persistence.
 *
 * Stores conversation history in PostgreSQL for resume/replay.
 * Inspired by pi's Agent session management and lsclaw's checkpoint-store.
 */

import { getDb } from '@los/infra/db';
import type { Message } from './providers/index.js';
import type { TurnSummary } from './loop.js';

export interface SessionRecord {
  id: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  nodeId?: string;
  requestId?: string;
  traceId?: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  turns: TurnSummary[];
  metadata: Record<string, unknown>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  project_id TEXT,
  user_id TEXT,
  node_id TEXT,
  request_id TEXT,
  trace_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  messages_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  turns_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS node_id TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS trace_id TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_tenant_project ON sessions(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_request_id ON sessions(request_id);
CREATE INDEX IF NOT EXISTS idx_sessions_trace_id ON sessions(trace_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
`;

let _initialized = false;

export async function ensureSessionStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(SCHEMA);
  _initialized = true;
}

export async function saveSession(session: SessionRecord): Promise<void> {
  await ensureSessionStore();
  const db = getDb();
  await db.query(`
    INSERT INTO sessions (
      id, tenant_id, project_id, user_id, node_id, request_id, trace_id,
      messages_json, turns_json, metadata_json, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, now())
    ON CONFLICT (id) DO UPDATE SET
      tenant_id = COALESCE(EXCLUDED.tenant_id, sessions.tenant_id),
      project_id = COALESCE(EXCLUDED.project_id, sessions.project_id),
      user_id = COALESCE(EXCLUDED.user_id, sessions.user_id),
      node_id = COALESCE(EXCLUDED.node_id, sessions.node_id),
      request_id = COALESCE(EXCLUDED.request_id, sessions.request_id),
      trace_id = COALESCE(EXCLUDED.trace_id, sessions.trace_id),
      messages_json = EXCLUDED.messages_json,
      turns_json = EXCLUDED.turns_json,
      metadata_json = EXCLUDED.metadata_json,
      updated_at = now()
  `, [
    session.id,
    session.tenantId ?? null,
    session.projectId ?? null,
    session.userId ?? null,
    session.nodeId ?? null,
    session.requestId ?? null,
    session.traceId ?? null,
    JSON.stringify(session.messages),
    JSON.stringify(session.turns),
    JSON.stringify(session.metadata),
  ]);
}

export async function loadSession(id: string): Promise<SessionRecord | null> {
  await ensureSessionStore();
  const db = getDb();
  const rows = await db.query<SessionRow>('SELECT * FROM sessions WHERE id = $1', [id]);
  const row = rows.rows[0];
  if (!row) return null;
  return rowToSession(row);
}

export async function listSessions(limit = 20): Promise<Pick<SessionRecord, 'id' | 'createdAt' | 'updatedAt' | 'metadata'>[]> {
  await ensureSessionStore();
  const db = getDb();
  const rows = await db.query<SessionRow>(
    'SELECT * FROM sessions ORDER BY updated_at DESC LIMIT $1',
    [limit],
  );
  return rows.rows.map(row => ({
    id: row.id,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    metadata: normalizeJsonObject(row.metadata_json),
  }));
}

export async function deleteSession(id: string): Promise<boolean> {
  await ensureSessionStore();
  const db = getDb();
  const rows = await db.query<{ id: string }>('DELETE FROM sessions WHERE id = $1 RETURNING id', [id]);
  return rows.rows.length > 0;
}

type SessionRow = {
  id: string;
  tenant_id: string | null;
  project_id: string | null;
  user_id: string | null;
  node_id: string | null;
  request_id: string | null;
  trace_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  messages_json: unknown;
  turns_json: unknown;
  metadata_json: unknown;
};

function rowToSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id ?? undefined,
    projectId: row.project_id ?? undefined,
    userId: row.user_id ?? undefined,
    nodeId: row.node_id ?? undefined,
    requestId: row.request_id ?? undefined,
    traceId: row.trace_id ?? undefined,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    messages: normalizeJsonArray(row.messages_json) as Message[],
    turns: normalizeJsonArray(row.turns_json) as TurnSummary[],
    metadata: normalizeJsonObject(row.metadata_json),
  };
}

function normalizeJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
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
