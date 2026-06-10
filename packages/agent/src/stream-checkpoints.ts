/**
 * @los/agent/stream-checkpoints — Durable stream event persistence.
 *
 * Stores per-event stream checkpoints (model.delta, tool_call, turn) so that
 * a different gateway can replay an interrupted live stream.
 *
 * This is separate from session_events, which stores audit-level summary
 * events. stream_checkpoints captures the high-frequency per-token/per-event
 * data needed for exact stream replay (ADR 0012 Phase 3).
 */

import { getDb } from '@los/infra/db';

// ── Types ───────────────────────────────────────────────

export interface StreamCheckpointRecord {
  id: number;
  sessionId: string;
  runSpecId?: string;
  turn: number;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CreateStreamCheckpointInput {
  sessionId: string;
  runSpecId?: string;
  turn?: number;
  eventType: string;
  payload?: Record<string, unknown>;
}

// ── Schema ──────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stream_checkpoints (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_spec_id TEXT,
  turn INTEGER NOT NULL DEFAULT 0,
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stream_checkpoints_session_id ON stream_checkpoints(session_id, id);
CREATE INDEX IF NOT EXISTS idx_stream_checkpoints_run_spec_id ON stream_checkpoints(run_spec_id, id);
CREATE INDEX IF NOT EXISTS idx_stream_checkpoints_created ON stream_checkpoints(created_at);
`;

let _initialized = false;

export async function ensureStreamCheckpointStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(SCHEMA);
  _initialized = true;
}

// ── CRUD ────────────────────────────────────────────────

export async function createStreamCheckpoint(
  input: CreateStreamCheckpointInput,
): Promise<StreamCheckpointRecord> {
  await ensureStreamCheckpointStore();
  const db = getDb();
  const rows = await db.query<StreamCheckpointRow>(
    `
    INSERT INTO stream_checkpoints (session_id, run_spec_id, turn, event_type, payload_json)
    VALUES ($1, $2, $3, $4, $5::jsonb)
    RETURNING *
  `,
    [
      input.sessionId,
      input.runSpecId ?? null,
      input.turn ?? 0,
      input.eventType,
      JSON.stringify(input.payload ?? {}),
    ],
  );
  return rowToRecord(assertRow(rows.rows[0]));
}

export async function listStreamCheckpointsSince(
  sessionId: string,
  sinceId: number,
  limit = 200,
): Promise<StreamCheckpointRecord[]> {
  await ensureStreamCheckpointStore();
  const db = getDb();
  const rows = await db.query<StreamCheckpointRow>(
    `
    SELECT *
    FROM stream_checkpoints
    WHERE session_id = $1 AND id > $2
    ORDER BY id ASC
    LIMIT $3
  `,
    [sessionId, sinceId, limit],
  );
  return rows.rows.map(rowToRecord);
}

export async function listStreamCheckpointsForRunSpec(
  runSpecId: string,
  sinceId: number,
  limit = 200,
): Promise<StreamCheckpointRecord[]> {
  await ensureStreamCheckpointStore();
  const db = getDb();
  const rows = await db.query<StreamCheckpointRow>(
    `
    SELECT *
    FROM stream_checkpoints
    WHERE run_spec_id = $1 AND id > $2
    ORDER BY id ASC
    LIMIT $3
  `,
    [runSpecId, sinceId, limit],
  );
  return rows.rows.map(rowToRecord);
}

// ── Helpers ─────────────────────────────────────────────

type StreamCheckpointRow = {
  id: number | string;
  session_id: string;
  run_spec_id: string | null;
  turn: number | string;
  event_type: string;
  payload_json: unknown;
  created_at: Date | string;
};

function rowToRecord(row: StreamCheckpointRow): StreamCheckpointRecord {
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    runSpecId: row.run_spec_id ?? undefined,
    turn: Number(row.turn),
    eventType: row.event_type,
    payload: normalizeJsonObject(row.payload_json),
    createdAt: toIsoString(row.created_at),
  };
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const p = JSON.parse(value);
      return p && typeof p === 'object' && !Array.isArray(p)
        ? (p as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('Failed to create stream checkpoint');
  return row;
}
