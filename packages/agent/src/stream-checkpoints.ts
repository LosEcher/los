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

/**
 * @los/agent/stream-checkpoints — Durable stream event persistence.
 *
 * Write path: FileEventLogBackend (~/.los/streams/<sessionId>/events.jsonl)
 * Read path:  FileEventLogBackend first, PG table as fallback for legacy data.
 *
 * The PG stream_checkpoints table is preserved for backward-compatible reads
 * but new writes go through the event log. This keeps ultra-high-frequency
 * per-token writes out of PostgreSQL.
 */
import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import { FileEventLogBackend, setEventLogBaseDir } from './event-log/file-backend.js';
import type { AppendEventInput } from './event-log/types.js';
import { randomUUID } from 'node:crypto';

const log = getLogger('stream-checkpoints');

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

// ── Event Log backend ───────────────────────────────────

let _eventLog: FileEventLogBackend | null = null;

function getEventLog(): FileEventLogBackend {
  if (!_eventLog) {
    _eventLog = new FileEventLogBackend();
  }
  return _eventLog;
}

export function setStreamCheckpointBaseDir(dir: string): void {
  setEventLogBaseDir(dir);
  _eventLog = null; // reset so it picks up the new dir
}

// ── Schema (PG — kept for legacy reads, NOT used for new writes) ──

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

let _pgReady = false;

/** @deprecated PG table is kept for backward reads only. New data writes through the event log. */
export async function ensureStreamCheckpointStore(): Promise<void> {
  if (_pgReady) return;
  const db = getDb();
  await db.exec(SCHEMA);
  _pgReady = true;
}

// ── Write (Event Log) ───────────────────────────────────

export async function createStreamCheckpoint(
  input: CreateStreamCheckpointInput,
): Promise<StreamCheckpointRecord> {
  const log_ = getEventLog();
  const event: AppendEventInput = {
    type: input.eventType,
    payload: {
      ...(input.payload ?? {}),
      _sessionId: input.sessionId,
      _runSpecId: input.runSpecId ?? undefined,
      _turn: input.turn ?? 0,
    },
    timestamp: new Date().toISOString(),
  };
  const ids = await log_.append(input.sessionId, [event]);
  if (input.runSpecId) {
    await log_.append(runSpecStream(input.runSpecId), [event]);
  }
  const id = ids[0]!;
  return {
    id,
    sessionId: input.sessionId,
    runSpecId: input.runSpecId,
    turn: input.turn ?? 0,
    eventType: input.eventType,
    payload: input.payload ?? {},
    createdAt: new Date().toISOString(),
  };
}

// ── Read (Event Log first, PG fallback) ──────────────────

export async function listStreamCheckpointsSince(
  sessionId: string,
  sinceId: number,
  limit = 200,
): Promise<StreamCheckpointRecord[]> {
  const log_ = getEventLog();
  const entries = await log_.read(sessionId, { fromId: sinceId, limit });
  const results = entries.map(e => ({
    id: e.id,
    sessionId: e.stream,
    runSpecId: (e.payload._runSpecId as string | undefined),
    turn: (e.payload._turn as number) ?? e.id,
    eventType: e.type,
    payload: stripInternal(e.payload),
    createdAt: e.timestamp,
  }));

  // If file backend returned nothing, fall back to PG for legacy data
  if (results.length === 0 && sinceId > 0) {
    return listStreamCheckpointsSincePg(sessionId, sinceId, limit);
  }

  return results;
}

export async function listStreamCheckpointsForRunSpec(
  runSpecId: string,
  sinceId: number,
  limit = 200,
): Promise<StreamCheckpointRecord[]> {
  const log_ = getEventLog();
  const entries = await log_.read(runSpecStream(runSpecId), { fromId: sinceId, limit: limit * 5 });
  const results = entries
    .filter(e => e.payload._runSpecId === runSpecId)
    .slice(0, limit)
    .map(e => ({
      id: e.id,
      sessionId: (e.payload._sessionId as string | undefined) ?? e.stream,
      runSpecId: (e.payload._runSpecId as string | undefined),
      turn: (e.payload._turn as number) ?? e.id,
      eventType: e.type,
      payload: stripInternal(e.payload),
      createdAt: e.timestamp,
    }));

  if (results.length === 0) {
    return listStreamCheckpointsForRunSpecPg(runSpecId, sinceId, limit);
  }

  return results;
}

// ── PG fallback readers (legacy data) ────────────────────

async function listStreamCheckpointsSincePg(
  sessionId: string,
  sinceId: number,
  limit = 200,
): Promise<StreamCheckpointRecord[]> {
  try {
    await ensureStreamCheckpointStore();
    const db = getDb();
    const rows = await db.query<StreamCheckpointRow>(
      `SELECT * FROM stream_checkpoints WHERE session_id = $1 AND id > $2 ORDER BY id ASC LIMIT $3`,
      [sessionId, sinceId, limit],
    );
    return rows.rows.map(rowToRecord);
  } catch (err) {
    log.warn(`PG fallback read failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function listStreamCheckpointsForRunSpecPg(
  runSpecId: string,
  sinceId: number,
  limit = 200,
): Promise<StreamCheckpointRecord[]> {
  try {
    await ensureStreamCheckpointStore();
    const db = getDb();
    const rows = await db.query<StreamCheckpointRow>(
      `SELECT * FROM stream_checkpoints WHERE run_spec_id = $1 AND id > $2 ORDER BY id ASC LIMIT $3`,
      [runSpecId, sinceId, limit],
    );
    return rows.rows.map(rowToRecord);
  } catch (err) {
    log.warn(`PG fallback read failed for run_spec ${runSpecId}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
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

function runSpecStream(runSpecId: string): string {
  return `run-spec/${runSpecId}`;
}

function stripInternal(payload: Record<string, unknown>): Record<string, unknown> {
  const { _sessionId, _runSpecId, _turn, ...rest } = payload;
  return rest;
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
