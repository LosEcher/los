import { createHash, randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getDb, withDbClient, type DbTransactionClient } from '@los/infra/db';
import type { RequestContext } from './request-context.js';
import { runAtomicEffect, runOwnedEffect } from './idempotency-execution.js';
export { completeIdempotencyKey, failIdempotencyKey } from './idempotency-execution.js';

const DEFAULT_IDEMPOTENCY_LEASE_MS = 30_000;
const IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'local',
  project_id TEXT NOT NULL DEFAULT 'los',
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  request_id TEXT NOT NULL,
  trace_id TEXT,
  status TEXT NOT NULL DEFAULT 'processing',
  response_status INTEGER,
  response_json JSONB,
  owner_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_scope_key
  ON idempotency_keys(tenant_id, project_id, method, route, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_idempotency_request ON idempotency_keys(request_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_trace ON idempotency_keys(trace_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_updated ON idempotency_keys(updated_at DESC);

ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS owner_id TEXT;
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_idempotency_processing_lease
  ON idempotency_keys(lease_expires_at)
  WHERE status = 'processing';
`;

let _initialized = false;

export async function ensureIdempotencyStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(SCHEMA);
  _initialized = true;
}

interface IdempotencyScopeOptions {
  route: string;
  method: string;
  body: unknown;
  context: RequestContext;
  leaseDurationMs?: number;
}

export interface IdempotentRequestOptions<T = unknown> extends IdempotencyScopeOptions {
  atomicEffect?: boolean;
  afterCommit?: (result: T) => Promise<void> | void;
}

export interface IdempotentTransaction {
  client: DbTransactionClient;
}

export async function runIdempotentJson<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  options: IdempotentRequestOptions<T>,
  handler: (transaction?: IdempotentTransaction) => Promise<T>,
): Promise<T | void> {
  const reservation = await reserveIdempotentRequest(req, options);
  if (!reservation) {
    const result = await handler();
    await options.afterCommit?.(result);
    return result;
  }

  reply.header('x-idempotency-key', reservation.idempotencyKey);
  reply.header('x-idempotency-status', reservation.status);

  if (reservation.status === 'body_mismatch') {
    return reply.status(409).send({
      error: 'idempotency key body mismatch',
      requestId: options.context.requestId,
      idempotencyKey: reservation.idempotencyKey,
    });
  }

  if (reservation.status === 'processing') {
    return reply.status(409).send({
      error: 'idempotency key is already processing',
      requestId: options.context.requestId,
      idempotencyKey: reservation.idempotencyKey,
    });
  }

  if (reservation.status === 'replayed') {
    const body = (reservation.responseJson ?? {}) as Record<string, unknown>;
    // Mark replayed responses so consumers can distinguish cached from fresh.
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const data = body['data'] as Record<string, unknown> | undefined;
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        data['deduplicated'] = true;
      }
    }
    return reply.status(reservation.responseStatus ?? 200).send(body);
  }
  if (reservation.status !== 'reserved' && reservation.status !== 'reclaimed') {
    throw new Error(`Unexpected idempotency reservation status: ${reservation.status}`);
  }

  return options.atomicEffect
    ? await runAtomicEffect(reservation, reply.statusCode || 200, handler, options.afterCommit)
    : await runOwnedEffect(reservation, reply.statusCode || 200, handler, options.afterCommit);
}

export type ReservationStatus = 'reserved' | 'reclaimed' | 'replayed' | 'processing' | 'body_mismatch';

interface ReserveInput extends IdempotencyScopeOptions {
  idempotencyKey: string;
  bodyHash: string;
  ownerId: string;
  now: Date;
  leaseExpiresAt: Date;
  leaseDurationMs: number;
  expiresAt: Date;
}

interface ReservationBase {
  id: string;
  idempotencyKey: string;
}

export interface OwnedReservation extends ReservationBase {
  status: 'reserved' | 'reclaimed';
  ownerId: string;
  leaseDurationMs: number;
}

export type Reservation =
  | OwnedReservation
  | (ReservationBase & {
      status: 'replayed';
      responseStatus?: number;
      responseJson?: unknown;
    })
  | (ReservationBase & {
      status: 'processing' | 'body_mismatch';
    });

type IdempotencyRow = {
  id: string;
  body_hash: string;
  status: string;
  response_status: number | null;
  response_json: unknown;
  owner_id: string | null;
  lease_expires_at: Date | string | null;
  expires_at: Date | string | null;
};

export async function reserveIdempotentRequest(
  req: FastifyRequest,
  options: IdempotencyScopeOptions,
): Promise<Reservation | null> {
  const idempotencyKey = getIdempotencyKey(req);
  if (!idempotencyKey) return null;

  await ensureIdempotencyStore();
  const now = new Date();
  const leaseDurationMs = normalizeLeaseDuration(options.leaseDurationMs);
  return await reserveIdempotencyKey({
    ...options,
    idempotencyKey,
    bodyHash: hashBody(options.body),
    ownerId: `idem-owner-${randomUUID()}`,
    now,
    leaseExpiresAt: new Date(now.getTime() + leaseDurationMs),
    leaseDurationMs,
    expiresAt: new Date(now.getTime() + IDEMPOTENCY_RETENTION_MS),
  });
}

export function getIdempotencyKey(req: FastifyRequest): string | undefined {
  return normalizeHeader(req.headers['idempotency-key'])
    ?? normalizeHeader(req.headers['x-idempotency-key']);
}

async function reserveIdempotencyKey(input: ReserveInput): Promise<Reservation> {
  return await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(
        `DELETE FROM idempotency_keys
         WHERE tenant_id = $1 AND project_id = $2 AND method = $3 AND route = $4
           AND idempotency_key = $5 AND expires_at IS NOT NULL AND expires_at <= $6`,
        [
          input.context.tenantId,
          input.context.projectId,
          input.method.toUpperCase(),
          input.route,
          input.idempotencyKey,
          input.now,
        ],
      );
      const inserted = await client.query<IdempotencyRow>(
        `
        INSERT INTO idempotency_keys (
          id, tenant_id, project_id, method, route, idempotency_key,
          body_hash, request_id, trace_id, status, owner_id, lease_expires_at, expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'processing', $10, $11, $12)
        ON CONFLICT DO NOTHING
        RETURNING id, body_hash, status, response_status, response_json,
                  owner_id, lease_expires_at, expires_at
      `,
        [
          `idem-${randomUUID()}`,
          input.context.tenantId,
          input.context.projectId,
          input.method.toUpperCase(),
          input.route,
          input.idempotencyKey,
          input.bodyHash,
          input.context.requestId,
          input.context.traceId,
          input.ownerId,
          input.leaseExpiresAt,
          input.expiresAt,
        ],
      );

      if (inserted.rows[0]) {
        await client.query('COMMIT');
        return {
          id: inserted.rows[0].id,
          idempotencyKey: input.idempotencyKey,
          ownerId: input.ownerId,
          leaseDurationMs: input.leaseDurationMs,
          status: 'reserved',
        };
      }

      const existing = await client.query<IdempotencyRow>(
        `
        SELECT id, body_hash, status, response_status, response_json,
               owner_id, lease_expires_at, expires_at
        FROM idempotency_keys
        WHERE tenant_id = $1
          AND project_id = $2
          AND method = $3
          AND route = $4
          AND idempotency_key = $5
        LIMIT 1
        FOR UPDATE
      `,
        [
          input.context.tenantId,
          input.context.projectId,
          input.method.toUpperCase(),
          input.route,
          input.idempotencyKey,
        ],
      );
      const row = existing.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return { id: '', idempotencyKey: input.idempotencyKey, status: 'processing' };
      }
      if (row.body_hash !== input.bodyHash) {
        await client.query('COMMIT');
        return { id: row.id, idempotencyKey: input.idempotencyKey, status: 'body_mismatch' };
      }
      if (row.status === 'completed' || row.status === 'failed') {
        await client.query('COMMIT');
        return {
          id: row.id,
          idempotencyKey: input.idempotencyKey,
          status: 'replayed',
          responseStatus: row.response_status ?? 200,
          responseJson: row.response_json,
        };
      }
      if (row.status === 'processing' && leaseExpired(row.lease_expires_at, input.now)) {
        const reclaimed = await client.query(
          `
          UPDATE idempotency_keys
          SET owner_id = $2,
              lease_expires_at = $3,
              expires_at = $4,
              request_id = $5,
              trace_id = $6,
              updated_at = $7
          WHERE id = $1 AND status = 'processing'
          RETURNING id
          `,
          [
            row.id,
            input.ownerId,
            input.leaseExpiresAt,
            input.expiresAt,
            input.context.requestId,
            input.context.traceId,
            input.now,
          ],
        );
        await client.query('COMMIT');
        if (reclaimed.rows[0]) {
          return {
            id: row.id,
            idempotencyKey: input.idempotencyKey,
            ownerId: input.ownerId,
            leaseDurationMs: input.leaseDurationMs,
            status: 'reclaimed',
          };
        }
      } else {
        await client.query('COMMIT');
      }
      return { id: row.id, idempotencyKey: input.idempotencyKey, status: 'processing' };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

function leaseExpired(value: Date | string | null, now: Date): boolean {
  return value == null || new Date(value).getTime() <= now.getTime();
}

function hashBody(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(',')}}`;
}

function normalizeHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeLeaseDuration(value: number | undefined): number {
  if (value === undefined) return DEFAULT_IDEMPOTENCY_LEASE_MS;
  if (!Number.isFinite(value) || value < 50) {
    throw new Error('Idempotency lease duration must be at least 50ms');
  }
  return Math.floor(value);
}
