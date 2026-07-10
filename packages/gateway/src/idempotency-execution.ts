import { getDb, withDbClient, type DbTransactionClient } from '@los/infra/db';
import type { IdempotentTransaction, OwnedReservation } from './idempotency.js';

export interface IdempotencyLeaseHeartbeat {
  stop: () => Promise<void>;
}

export function startIdempotencyLeaseHeartbeat(
  reservation: OwnedReservation,
  options: {
    intervalMs?: number;
    onLeaseLost?: (error: Error) => void;
  } = {},
): IdempotencyLeaseHeartbeat {
  const intervalMs = options.intervalMs
    ?? Math.max(25, Math.floor(reservation.leaseDurationMs / 3));
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let pending = Promise.resolve();

  const loseLease = (error: unknown) => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    options.onLeaseLost?.(error instanceof Error ? error : new Error(String(error)));
  };
  const tick = () => {
    if (stopped) return;
    pending = pending
      .then(async () => {
        if (stopped) return;
        const renewed = await renewIdempotencyLease(reservation);
        if (!renewed) loseLease(new Error('Idempotency reservation ownership was lost during execution'));
      })
      .catch(loseLease);
  };

  timer = setInterval(tick, intervalMs);
  timer.unref();

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearInterval(timer);
      await pending;
    },
  };
}

async function renewIdempotencyLease(reservation: OwnedReservation): Promise<boolean> {
  const result = await getDb().query(
    `UPDATE idempotency_keys
     SET lease_expires_at = now() + ($3::bigint * interval '1 millisecond'),
         updated_at = now()
     WHERE id = $1 AND status = 'processing' AND owner_id = $2
     RETURNING id`,
    [reservation.id, reservation.ownerId, reservation.leaseDurationMs],
  );
  return Boolean(result.rows[0]);
}

export async function runAtomicEffect<T>(
  reservation: OwnedReservation,
  responseStatus: number,
  handler: (transaction?: IdempotentTransaction) => Promise<T>,
  afterCommit?: (result: T) => Promise<void> | void,
): Promise<T> {
  if (!reservation.ownerId) throw new Error('Idempotency reservation owner is required');
  const ownerId = reservation.ownerId;
  try {
    const result = await withDbClient(async client => {
      await client.query('BEGIN');
      try {
        const owned = await client.query(
          `SELECT id FROM idempotency_keys
           WHERE id = $1 AND status = 'processing' AND owner_id = $2
           FOR UPDATE`,
          [reservation.id, ownerId],
        );
        if (!owned.rows[0]) throw new Error('Idempotency reservation ownership was lost');
        const value = await handler({ client });
        await completeIdempotencyKeyWithQuery(
          (sql, params) => client.query(sql, params),
          reservation.id,
          ownerId,
          responseStatus,
          value,
        );
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
    await afterCommit?.(result);
    return result;
  } catch (error) {
    await releaseIdempotencyLease(reservation.id, ownerId);
    throw error;
  }
}

export async function runOwnedEffect<T>(
  reservation: OwnedReservation,
  responseStatus: number,
  handler: (transaction?: IdempotentTransaction) => Promise<T>,
  afterCommit?: (result: T) => Promise<void> | void,
): Promise<T> {
  if (!reservation.ownerId) throw new Error('Idempotency reservation owner is required');
  const ownerId = reservation.ownerId;
  try {
    const result = await handler();
    await completeIdempotencyKey(reservation.id, responseStatus, result, ownerId);
    await afterCommit?.(result);
    return result;
  } catch (error) {
    await releaseIdempotencyLease(reservation.id, ownerId);
    throw error;
  }
}

type IdempotencyQuery = (
  sql: string,
  params: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

async function completeIdempotencyKeyWithQuery(
  query: IdempotencyQuery,
  id: string,
  ownerId: string,
  status: number,
  response: unknown,
): Promise<void> {
  const result = await query(
    `
    UPDATE idempotency_keys
    SET status = 'completed',
        response_status = $2,
        response_json = $3::jsonb,
        lease_expires_at = NULL,
        updated_at = now()
    WHERE id = $1 AND status = 'processing' AND owner_id = $4
    RETURNING id
    `,
    [id, status, JSON.stringify(response ?? {}), ownerId],
  );
  if (!result.rows[0]) throw new Error('Idempotency reservation ownership was lost before completion');
}

export async function completeIdempotencyKey(
  id: string,
  status: number,
  response: unknown,
  ownerId: string,
): Promise<void> {
  await completeIdempotencyKeyWithQuery(
    (sql, params) => getDb().query(sql, params),
    id,
    ownerId,
    status,
    response,
  );
}

export async function failIdempotencyKey(id: string, error: unknown, ownerId: string): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await getDb().query(
    `
    UPDATE idempotency_keys
    SET status = 'failed',
        response_status = 500,
        response_json = $2::jsonb,
        lease_expires_at = NULL,
        updated_at = now()
    WHERE id = $1 AND status = 'processing' AND owner_id = $3
    `,
    [id, JSON.stringify({ error: message }), ownerId],
  );
}

async function releaseIdempotencyLease(id: string, ownerId: string): Promise<void> {
  await getDb().query(
    `
    UPDATE idempotency_keys
    SET lease_expires_at = now(),
        updated_at = now()
    WHERE id = $1 AND status = 'processing' AND owner_id = $2
    `,
    [id, ownerId],
  );
}
