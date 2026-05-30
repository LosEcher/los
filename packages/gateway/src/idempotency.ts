import { createHash, randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getDb, withDbClient } from '@los/infra/db';
import type { RequestContext } from './request-context.js';

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_scope_key
  ON idempotency_keys(tenant_id, project_id, method, route, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_idempotency_request ON idempotency_keys(request_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_trace ON idempotency_keys(trace_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_updated ON idempotency_keys(updated_at DESC);
`;

let _initialized = false;

export async function ensureIdempotencyStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(SCHEMA);
  _initialized = true;
}

export interface IdempotentRequestOptions {
  route: string;
  method: string;
  body: unknown;
  context: RequestContext;
}

export async function runIdempotentJson<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  options: IdempotentRequestOptions,
  handler: () => Promise<T>,
): Promise<T | void> {
  const reservation = await reserveIdempotentRequest(req, options);
  if (!reservation) {
    return await handler();
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
    return reply.status(reservation.responseStatus ?? 200).send(reservation.responseJson ?? {});
  }

  try {
    const result = await handler();
    await completeIdempotencyKey(reservation.id, reply.statusCode || 200, result);
    return result;
  } catch (error) {
    await failIdempotencyKey(reservation.id, error);
    throw error;
  }
}

export type ReservationStatus = 'reserved' | 'replayed' | 'processing' | 'body_mismatch';

interface ReserveInput extends IdempotentRequestOptions {
  idempotencyKey: string;
  bodyHash: string;
}

export interface Reservation {
  id: string;
  idempotencyKey: string;
  status: ReservationStatus;
  responseStatus?: number;
  responseJson?: unknown;
}

type IdempotencyRow = {
  id: string;
  body_hash: string;
  status: string;
  response_status: number | null;
  response_json: unknown;
};

export async function reserveIdempotentRequest(
  req: FastifyRequest,
  options: IdempotentRequestOptions,
): Promise<Reservation | null> {
  const idempotencyKey = getIdempotencyKey(req);
  if (!idempotencyKey) return null;

  await ensureIdempotencyStore();
  return await reserveIdempotencyKey({
    ...options,
    idempotencyKey,
    bodyHash: hashBody(options.body),
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
      const inserted = await client.query<IdempotencyRow>(
        `
        INSERT INTO idempotency_keys (
          id, tenant_id, project_id, method, route, idempotency_key,
          body_hash, request_id, trace_id, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'processing')
        ON CONFLICT DO NOTHING
        RETURNING id, body_hash, status, response_status, response_json
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
        ],
      );

      if (inserted.rows[0]) {
        await client.query('COMMIT');
        return { id: inserted.rows[0].id, idempotencyKey: input.idempotencyKey, status: 'reserved' };
      }

      const existing = await client.query<IdempotencyRow>(
        `
        SELECT id, body_hash, status, response_status, response_json
        FROM idempotency_keys
        WHERE tenant_id = $1
          AND project_id = $2
          AND method = $3
          AND route = $4
          AND idempotency_key = $5
        LIMIT 1
      `,
        [
          input.context.tenantId,
          input.context.projectId,
          input.method.toUpperCase(),
          input.route,
          input.idempotencyKey,
        ],
      );
      await client.query('COMMIT');

      const row = existing.rows[0];
      if (!row) return { id: '', idempotencyKey: input.idempotencyKey, status: 'processing' };
      if (row.body_hash !== input.bodyHash) {
        return { id: row.id, idempotencyKey: input.idempotencyKey, status: 'body_mismatch' };
      }
      if (row.status === 'completed' || row.status === 'failed') {
        return {
          id: row.id,
          idempotencyKey: input.idempotencyKey,
          status: 'replayed',
          responseStatus: row.response_status ?? 200,
          responseJson: row.response_json,
        };
      }
      return { id: row.id, idempotencyKey: input.idempotencyKey, status: 'processing' };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

export async function completeIdempotencyKey(id: string, status: number, response: unknown): Promise<void> {
  const db = getDb();
  await db.query(
    `
    UPDATE idempotency_keys
    SET status = 'completed',
        response_status = $2,
        response_json = $3::jsonb,
        updated_at = now()
    WHERE id = $1
  `,
    [id, status, JSON.stringify(response ?? {})],
  );
}

export async function failIdempotencyKey(id: string, error: unknown): Promise<void> {
  const db = getDb();
  const message = error instanceof Error ? error.message : String(error);
  await db.query(
    `
    UPDATE idempotency_keys
    SET status = 'failed',
        response_status = 500,
        response_json = $2::jsonb,
        updated_at = now()
    WHERE id = $1
  `,
    [id, JSON.stringify({ error: message })],
  );
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
