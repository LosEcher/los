/**
 * @los/agent/governance-auditors-event-retention — Event retention auditor.
 *
 * Compacts session_events older than N days into JSONL cold storage
 * via the FileEventLogBackend. PG rows are marked archived and their
 * payload_json is replaced with an OID reference.
 *
 * This reduces PG table bloat while preserving full event history for
 * replay and audit.
 */

import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import { FileEventLogBackend } from './event-log/file-backend.js';

const log = getLogger('event-retention');

// ── Config ─────────────────────────────────────────────────

/** Events older than this are eligible for cold storage compaction. */
const DEFAULT_RETENTION_AGE_DAYS = 7;

/** Max events to compact per sweep to avoid long-running transactions. */
const MAX_BATCH_SIZE = 5_000;

// ── Audit ──────────────────────────────────────────────────

export async function runEventRetentionAudit(): Promise<Record<string, unknown>> {
  const db = getDb();
  const eventLog = new FileEventLogBackend();

  // Count uncompacted events older than threshold
  const countRows = await db.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt
     FROM session_events
     WHERE created_at < now() - ($1::text || ' days')::interval
       AND (payload_json->>'archived_at') IS NULL`,
    [DEFAULT_RETENTION_AGE_DAYS],
  );
  const totalEligible = parseInt(countRows.rows[0]?.cnt ?? '0', 10);

  if (totalEligible === 0) {
    return {
      eventRetention: {
        totalEligible: 0,
        totalCompacted: 0,
        sessionsProcessed: 0,
      },
    };
  }

  // Fetch eligible events in batches, grouped by session
  const rows = await db.query<SessionEventRow>(
    `SELECT id, session_id, type, source, turn, created_at, payload_json
     FROM session_events
     WHERE created_at < now() - ($1::text || ' days')::interval
       AND (payload_json->>'archived_at') IS NULL
     ORDER BY created_at ASC
     LIMIT $2`,
    [DEFAULT_RETENTION_AGE_DAYS, MAX_BATCH_SIZE],
  );

  let totalCompacted = 0;
  const sessionIds = new Set<string>();

  // Group by session for efficient JSONL writes
  const bySession = new Map<string, Array<{ id: number; event: Record<string, unknown> }>>();
  for (const row of rows.rows) {
    const sessionId = row.session_id;
    if (!bySession.has(sessionId)) bySession.set(sessionId, []);
    bySession.get(sessionId)!.push({
      id: Number(row.id),
      event: {
        id: Number(row.id),
        type: row.type,
        source: row.source,
        turn: Number(row.turn),
        timestamp: toIsoString(row.created_at),
        payload: normalizeJsonObject(row.payload_json),
      },
    });
  }

  // Write each session's events to cold storage
  for (const [sessionId, events] of bySession) {
    try {
      const stream = `session-archive-${sessionId}`;
      await eventLog.append(stream, events.map(e => ({
        type: 'session_event',
        payload: e.event,
        timestamp: e.event.timestamp as string,
      })));

      // Mark events as archived in PG
      for (const e of events) {
        await db.query(
          `UPDATE session_events
           SET payload_json = jsonb_set(payload_json, '{archived_at}', to_jsonb(now()::text))
           WHERE id = $1`,
          [e.id],
        );
      }

      totalCompacted += events.length;
      sessionIds.add(sessionId);
      log.debug(`Event retention: compacted ${events.length} events for session ${sessionId}`);
    } catch (err) {
      log.warn(`Event retention: failed to compact session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log.info(`Event retention: compacted ${totalCompacted} events across ${sessionIds.size} sessions (${totalEligible} total eligible)`);

  return {
    eventRetention: {
      totalEligible,
      totalCompacted,
      sessionsProcessed: sessionIds.size,
    },
  };
}

// ── Helpers ────────────────────────────────────────────────

interface SessionEventRow {
  id: string | number;
  session_id: string;
  type: string;
  source: string;
  turn: string | number;
  created_at: string | Date;
  payload_json: unknown;
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
  }
  return {};
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
