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
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  turns: TurnSummary[];
  metadata: Record<string, unknown>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  messages_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  turns_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
);
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
    INSERT INTO sessions (id, messages_json, turns_json, metadata_json, updated_at)
    VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, now())
    ON CONFLICT (id) DO UPDATE SET
      messages_json = EXCLUDED.messages_json,
      turns_json = EXCLUDED.turns_json,
      metadata_json = EXCLUDED.metadata_json,
      updated_at = now()
  `, [
    session.id,
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
    'SELECT id, created_at, updated_at, metadata_json, messages_json, turns_json FROM sessions ORDER BY updated_at DESC LIMIT $1',
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
  created_at: Date | string;
  updated_at: Date | string;
  messages_json: unknown;
  turns_json: unknown;
  metadata_json: unknown;
};

function rowToSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
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
