/**
 * @los/agent/coordination/pg-backend — PostgreSQL-backed coordination for mesh deployments.
 *
 * Wraps the existing PG primitives (advisory locks, NOTIFY/LISTEN, lease columns)
 * behind the CoordinationBackend interface. This is the default backend when
 * a PG database is available and LOS_MESH_MODE is not explicitly off.
 */

import { getDb, getPool } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';

import type {
  LockBackend,
  LeaseBackend,
  LeaseHandle,
  NotifyBackend,
  CoordinationBackend,
} from './types.js';

const log = getLogger('coordination-pg');

type AdvisoryLockClient = {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  release(): void;
};

// ── Lock Backend (pg_advisory_lock) ───────────────────────

class PgLockBackend implements LockBackend {
  /**
   * Hash the key into a bigint for pg_advisory_lock.
   * Uses a simple djb2-like hash for consistent mapping.
   */
  private hashKey(key: string): number {
    const lockKey = process.env.LOS_TEST_SCHEMA
      ? `${process.env.LOS_TEST_SCHEMA}:${key}`
      : key;
    let hash = 5381;
    for (let i = 0; i < lockKey.length; i++) {
      hash = ((hash << 5) + hash + lockKey.charCodeAt(i)) | 0;
    }
    return hash >>> 0; // unsigned 32-bit → fits in pg bigint
  }

  async acquire(key: string): Promise<() => Promise<void>> {
    const lockId = this.hashKey(key);
    const client = await getPool().connect();
    await client.query(`SELECT pg_advisory_lock($1)`, [lockId]);
    return async () => {
      try {
        await client.query(`SELECT pg_advisory_unlock($1)`, [lockId]);
      } catch {
        // Lock released on connection close anyway
      } finally {
        client.release();
      }
    };
  }

  async tryAcquire(key: string): Promise<{ release: () => Promise<void> } | null> {
    const lockId = this.hashKey(key);
    const client = await getPool().connect();
    const releaseClient = () => client.release();
    const rows = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock($1) AS acquired`,
      [lockId],
    );
    if (!rows.rows[0]?.acquired) {
      releaseClient();
      return null;
    }
    return {
      release: makeAdvisoryLockRelease(client, lockId),
    };
  }

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
    const result = await this.tryAcquire(key);
    if (!result) {
      log.debug(`Lock "${key}" held by another process, skipping`);
      return null;
    }
    try {
      return await fn();
    } finally {
      await result.release();
    }
  }
}

function makeAdvisoryLockRelease(client: AdvisoryLockClient, lockId: number): () => Promise<void> {
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query(`SELECT pg_advisory_unlock($1)`, [lockId]);
    } catch { /* ok */ }
    finally {
      client.release();
    }
  };
}

// ── Lease Backend (PG lease_expires_at column pattern) ─────

/**
 * PG-based lease backend. Uses a generic lease table.
 * Each lease is a row identified by (resource, owner).
 * Overlapping with existing task_runs.lease_expires_at /
 * agent_tasks.lease_expires_at — those tables continue to manage
 * their own leases for compatibility. This backend is for
 * new coordination use cases.
 */
class PgLeaseBackend implements LeaseBackend {
  private schemaReady = false;

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    const db = getDb();
    await db.exec(`
      CREATE TABLE IF NOT EXISTS coordination_leases (
        resource TEXT NOT NULL,
        owner TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (resource)
      );
      CREATE INDEX IF NOT EXISTS idx_coordination_leases_expires
        ON coordination_leases(expires_at);
    `);
    this.schemaReady = true;
  }

  async acquire(resource: string, ttlMs: number, owner: string): Promise<LeaseHandle | null> {
    await this.ensureSchema();
    const db = getDb();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const rows = await db.query<LeaseRow>(
      `
      INSERT INTO coordination_leases (resource, owner, expires_at)
      VALUES ($1, $2, $3::timestamptz)
      ON CONFLICT (resource) DO UPDATE SET
        owner = CASE
          WHEN coordination_leases.expires_at < now() THEN EXCLUDED.owner
          WHEN coordination_leases.owner = EXCLUDED.owner THEN EXCLUDED.owner
          ELSE coordination_leases.owner
        END,
        expires_at = CASE
          WHEN coordination_leases.expires_at < now() THEN EXCLUDED.expires_at
          WHEN coordination_leases.owner = EXCLUDED.owner THEN EXCLUDED.expires_at
          ELSE coordination_leases.expires_at
        END
      RETURNING *
    `,
      [resource, owner, expiresAt],
    );
    const row = rows.rows[0];
    if (!row) return null;
    if (row.owner !== owner && new Date(row.expires_at) > new Date()) {
      // Another owner holds a valid lease
      return null;
    }
    // The UPSERT gave us the lease (either fresh or reclaimed)
    // Update to ensure we own it
    if (row.owner !== owner) {
      await db.query(
        `UPDATE coordination_leases SET owner = $2, expires_at = $3::timestamptz WHERE resource = $1`,
        [resource, owner, expiresAt],
      );
    }
    return rowToLeaseHandle({ ...row, owner, expires_at: expiresAt });
  }

  async heartbeat(handle: LeaseHandle, ttlMs: number = 300_000): Promise<boolean> {
    await this.ensureSchema();
    const db = getDb();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const rows = await db.query<LeaseRow>(
      `
      UPDATE coordination_leases
      SET expires_at = $3::timestamptz
      WHERE resource = $1 AND owner = $2 AND expires_at > now()
      RETURNING *
    `,
      [handle.resource, handle.owner, expiresAt],
    );
    return rows.rows.length > 0;
  }

  async reapExpired(resourcePattern: string): Promise<LeaseHandle[]> {
    await this.ensureSchema();
    const db = getDb();
    const rows = await db.query<LeaseRow>(
      `
      DELETE FROM coordination_leases
      WHERE resource LIKE $1 AND expires_at < now()
      RETURNING *
    `,
      [resourcePattern.replace(/\*/g, '%')],
    );
    return rows.rows.map(rowToLeaseHandle);
  }

  async release(handle: LeaseHandle): Promise<void> {
    await this.ensureSchema();
    const db = getDb();
    await db.query(
      `DELETE FROM coordination_leases WHERE resource = $1 AND owner = $2`,
      [handle.resource, handle.owner],
    );
  }
}

// ── Notify Backend (PG NOTIFY / LISTEN) ────────────────────

class PgNotifyBackend implements NotifyBackend {
  private channels = new Map<string, Set<(payload: unknown) => void>>();
  private listenSetup = false;
  private pgClient: any = null;

  private async setupListen(): Promise<void> {
    if (this.listenSetup) return;
    try {
      const pool = getPool();
      this.pgClient = await pool.connect();
      this.pgClient.on('notification', (msg: { channel: string; payload: string }) => {
        const handlers = this.channels.get(msg.channel);
        if (!handlers) return;
        let payload: unknown = msg.payload;
        try {
          if (msg.payload) payload = JSON.parse(msg.payload);
        } catch { /* raw string is fine */ }
        for (const handler of handlers) {
          try { handler(payload); } catch { /* best-effort */ }
        }
      });
      // LISTEN on all currently subscribed channels
      for (const channel of this.channels.keys()) {
        await this.pgClient.query(`LISTEN "${channel}"`);
      }
      this.listenSetup = true;
      log.info('Coordination PG NOTIFY: listener active');
    } catch (err) {
      log.warn(`PG NOTIFY listener setup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    try {
      const db = getDb();
      const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
      await db.notify(channel, payloadStr);
    } catch (err) {
      log.warn(`PG NOTIFY publish to "${channel}" failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  subscribe(channel: string, handler: (payload: unknown) => void): () => void {
    let handlers = this.channels.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.channels.set(channel, handlers);
    }
    handlers.add(handler);

    // Start listening if not already
    this.setupListen().catch(() => {});

    return () => {
      handlers?.delete(handler);
      if (handlers?.size === 0) this.channels.delete(channel);
    };
  }

  subscribeWithFallback(
    channel: string,
    handler: (payload: unknown) => void,
    fallbackIntervalMs: number,
  ): { unsubscribe: () => void; fallbackTimer?: ReturnType<typeof setInterval> } {
    const unsubscribe = this.subscribe(channel, handler);
    const fallbackTimer = setInterval(() => handler({ _fallback: true, channel }), fallbackIntervalMs);
    return {
      unsubscribe: () => {
        unsubscribe();
        clearInterval(fallbackTimer);
      },
      fallbackTimer,
    };
  }
}

// ── Helpers ────────────────────────────────────────────────

interface LeaseRow {
  resource: string;
  owner: string;
  expires_at: string | Date;
  metadata_json?: unknown;
}

function rowToLeaseHandle(row: LeaseRow): LeaseHandle {
  return {
    resource: row.resource,
    owner: row.owner,
    expiresAt: new Date(row.expires_at),
    metadata: typeof row.metadata_json === 'object' && row.metadata_json !== null
      ? row.metadata_json as Record<string, unknown>
      : undefined,
  };
}

// ── Factory ────────────────────────────────────────────────

export function createPgCoordinationBackend(): CoordinationBackend {
  return {
    mode: 'mesh',
    lock: new PgLockBackend(),
    lease: new PgLeaseBackend(),
    notify: new PgNotifyBackend(),
  };
}

export { PgLockBackend, PgLeaseBackend, PgNotifyBackend };
