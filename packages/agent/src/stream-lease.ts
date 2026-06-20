/**
 * @los/agent/stream-lease — Cross-gateway session ownership lease.
 *
 * When a gateway serves a live SSE session, it writes a stream_lease with a
 * heartbeat. On reconnect, a different gateway can check whether the original
 * lease has expired before taking over. This prevents split-brain delivery
 * and enables clean cross-gateway failover.
 *
 * Schema:
 *   - lease_id TEXT (session_id + gateway) — unique per session-gateway pair
 *   - session_id TEXT NOT NULL
 *   - gateway TEXT NOT NULL
 *   - status TEXT: 'active' | 'released' | 'expired'
 *   - heartbeat_at TIMESTAMPTZ
 *   - created_at / updated_at TIMESTAMPTZ
 *
 * Lifecycle:
 *   1. acquire → status='active', heartbeat_at=now()
 *   2. heartbeat → heartbeat_at=now() (every ~10s)
 *   3. release → status='released', heartbeat_at=now()
 *   4. expire → checkLeaseExpiry: heartbeat > 30s stale → status='expired'
 */

import { getDb } from '@los/infra/db';

// ── Types ───────────────────────────────────────────────

export interface StreamLeaseRecord {
  leaseId: string;
  sessionId: string;
  gateway: string;
  status: 'active' | 'released' | 'expired';
  heartbeatAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AcquireLeaseInput {
  sessionId: string;
  gateway: string;
  /** Lease TTL in seconds. Default: 30 */
  ttlSeconds?: number;
}

export interface ReconnectInfo {
  /** Whether the previous gateway's lease has expired */
  canTakeover: boolean;
  /** The previous lease, if any */
  previousLease: StreamLeaseRecord | null;
  /** The new lease, if acquired */
  newLease: StreamLeaseRecord | null;
  /** Reason for the decision */
  reason: string;
}

// ── Schema ──────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stream_leases (
  lease_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  gateway TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'expired')),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stream_leases_session ON stream_leases(session_id, status);
CREATE INDEX IF NOT EXISTS idx_stream_leases_heartbeat ON stream_leases(heartbeat_at);
`;

let _initialized = false;

export async function ensureStreamLeaseStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(SCHEMA);
  _initialized = true;
}

// ── Lease CRUD ──────────────────────────────────────────

function buildLeaseId(sessionId: string, gateway: string): string {
  return `${sessionId}:${gateway}`;
}

/**
 * Acquire a lease for a session. If a different gateway already holds an
 * active lease that hasn't expired, the acquire is rejected.
 */
export async function acquireStreamLease(
  input: AcquireLeaseInput,
): Promise<ReconnectInfo> {
  await ensureStreamLeaseStore();
  const db = getDb();
  const leaseId = buildLeaseId(input.sessionId, input.gateway);
  const ttlSeconds = input.ttlSeconds ?? 30;

  // Check for existing active leases
  const existing = await db.query<StreamLeaseRow>(
    `SELECT * FROM stream_leases WHERE session_id = $1 AND status = 'active'`,
    [input.sessionId],
  );

  for (const row of existing.rows) {
    const heartbeatMs = new Date(row.heartbeat_at).getTime();
    const ageSeconds = (Date.now() - heartbeatMs) / 1000;

    if (ageSeconds < ttlSeconds && row.gateway !== input.gateway) {
      // Another gateway holds a fresh lease — take over is blocked
      return {
        canTakeover: false,
        previousLease: rowToRecord(row),
        newLease: null,
        reason: `Lease held by ${row.gateway} (heartbeat ${Math.round(ageSeconds)}s ago, TTL ${ttlSeconds}s)`,
      };
    }

    if (ageSeconds >= ttlSeconds) {
      // Expire stale lease
      await db.query(
        `UPDATE stream_leases SET status = 'expired', updated_at = now() WHERE lease_id = $1`,
        [row.lease_id],
      );
    }
  }

  // Upsert new active lease
  const rows = await db.query<StreamLeaseRow>(
    `
    INSERT INTO stream_leases (lease_id, session_id, gateway, status, heartbeat_at)
    VALUES ($1, $2, $3, 'active', now())
    ON CONFLICT (lease_id) DO UPDATE
      SET status = 'active', heartbeat_at = now(), updated_at = now()
    RETURNING *
  `,
    [leaseId, input.sessionId, input.gateway],
  );

  return {
    canTakeover: true,
    previousLease: existing.rows.length > 0 ? rowToRecord(existing.rows[0]) : null,
    newLease: rowToRecord(assertRow(rows.rows[0])),
    reason: 'Lease acquired',
  };
}

/**
 * Update heartbeat timestamp to keep lease alive.
 */
export async function heartbeatStreamLease(
  sessionId: string,
  gateway: string,
): Promise<void> {
  await ensureStreamLeaseStore();
  const db = getDb();
  const leaseId = buildLeaseId(sessionId, gateway);
  await db.query(
    `UPDATE stream_leases SET heartbeat_at = now(), updated_at = now() WHERE lease_id = $1`,
    [leaseId],
  );
}

/**
 * Release a lease.
 */
export async function releaseStreamLease(
  sessionId: string,
  gateway: string,
): Promise<void> {
  await ensureStreamLeaseStore();
  const db = getDb();
  const leaseId = buildLeaseId(sessionId, gateway);
  await db.query(
    `UPDATE stream_leases SET status = 'released', updated_at = now(), heartbeat_at = now() WHERE lease_id = $1`,
    [leaseId],
  );
}

/**
 * Get the current active lease for a session, if any.
 */
export async function getActiveLease(
  sessionId: string,
): Promise<StreamLeaseRecord | null> {
  await ensureStreamLeaseStore();
  const db = getDb();
  const rows = await db.query<StreamLeaseRow>(
    `SELECT * FROM stream_leases WHERE session_id = $1 AND status = 'active' ORDER BY heartbeat_at DESC LIMIT 1`,
    [sessionId],
  );
  return rows.rows.length > 0 ? rowToRecord(rows.rows[0]) : null;
}

// ── Helpers ─────────────────────────────────────────────

type StreamLeaseRow = {
  lease_id: string;
  session_id: string;
  gateway: string;
  status: string;
  heartbeat_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
};

function rowToRecord(row: StreamLeaseRow): StreamLeaseRecord {
  return {
    leaseId: row.lease_id,
    sessionId: row.session_id,
    gateway: row.gateway,
    status: row.status as StreamLeaseRecord['status'],
    heartbeatAt: row.heartbeat_at instanceof Date ? row.heartbeat_at.toISOString() : String(row.heartbeat_at),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('Failed to create stream lease');
  return row;
}
