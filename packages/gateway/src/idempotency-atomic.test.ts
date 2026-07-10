import assert from 'node:assert/strict';
import test from 'node:test';

import { appendSessionEvent, ensureSessionEventStore, listSessionEvents } from '@los/agent';
import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  completeIdempotencyKey,
  ensureIdempotencyStore,
  reserveIdempotentRequest,
  runIdempotentJson,
  type IdempotentTransaction,
  type Reservation,
} from './idempotency.js';
import { startIdempotencyLeaseHeartbeat } from './idempotency-execution.js';
import { getRequestContext } from './request-context.js';

type EffectHandler = (transaction?: IdempotentTransaction) => Promise<unknown>;

interface IdempotencyHarness {
  app: FastifyInstance;
  setHandler: (handler: EffectHandler) => void;
  setReserveOnly: (enabled: boolean) => void;
}

test.before(async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureIdempotencyStore();
  await ensureSessionEventStore();
});

test.after(async () => {
  await closeDb().catch(() => undefined);
});

test('effect failure releases the lease so a retry reclaims and succeeds once', async () => {
  const suffix = uniqueSuffix();
  const idempotencyKey = `idem-before-effect-${suffix}`;
  const harness = createHarness(`before-effect-${suffix}`);
  let attempt = 0;
  let effectCount = 0;

  harness.setHandler(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('crash before effect');
    effectCount += 1;
    return { ok: true };
  });

  try {
    const first = await inject(harness.app, idempotencyKey);
    assert.equal(first.statusCode, 500);
    assert.equal(effectCount, 0);

    const retry = await inject(harness.app, idempotencyKey);
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.headers['x-idempotency-status'], 'reclaimed');
    assert.deepEqual(retry.json(), { ok: true });
    assert.equal(effectCount, 1);

    const row = await loadIdempotencyRow(idempotencyKey);
    assert.equal(row?.status, 'completed');
  } finally {
    await cleanup(harness.app, idempotencyKey);
  }
});

test('atomic session event rolls back on failure, then commits once and replays', async () => {
  const suffix = uniqueSuffix();
  const sessionId = `session-idem-atomic-${suffix}`;
  const idempotencyKey = `idem-after-effect-${suffix}`;
  const harness = createHarness(`after-effect-${suffix}`);
  let attempt = 0;

  harness.setHandler(async transaction => {
    assert.ok(transaction);
    attempt += 1;
    const event = await appendSessionEvent({
      sessionId,
      type: 'operator.steering',
      source: 'operator',
      payload: { reason: 'atomic-idempotency-test' },
    }, { client: transaction.client, notify: false });
    if (attempt === 1) throw new Error('crash after effect before completion');
    return { ok: true, eventId: event.id };
  });

  try {
    const first = await inject(harness.app, idempotencyKey);
    assert.equal(first.statusCode, 500);
    assert.deepEqual(await listSessionEvents(sessionId), []);

    const retry = await inject(harness.app, idempotencyKey);
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.headers['x-idempotency-status'], 'reclaimed');
    const retryBody = retry.json<{ ok: boolean; eventId: number }>();
    assert.equal(retryBody.ok, true);

    const replay = await inject(harness.app, idempotencyKey);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.headers['x-idempotency-status'], 'replayed');
    assert.deepEqual(replay.json(), retryBody);

    const events = await listSessionEvents(sessionId);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.id, retryBody.eventId);
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await cleanup(harness.app, idempotencyKey);
  }
});

test('expired processing lease is reclaimed and rejects the stale owner', async () => {
  const suffix = uniqueSuffix();
  const idempotencyKey = `idem-stale-owner-${suffix}`;
  const harness = createHarness(`stale-owner-${suffix}`, false);
  harness.setReserveOnly(true);

  try {
    const reservedResponse = await inject(harness.app, idempotencyKey);
    assert.equal(reservedResponse.statusCode, 200);
    const staleReservation = reservedResponse.json<Reservation>();
    assert.equal(staleReservation.status, 'reserved');
    assert.ok(staleReservation.ownerId);

    await getDb().query(
      `UPDATE idempotency_keys SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [staleReservation.id],
    );

    let releaseEffect: (() => void) | undefined;
    let effectStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { effectStarted = resolve; });
    const release = new Promise<void>(resolve => { releaseEffect = resolve; });
    harness.setReserveOnly(false);
    harness.setHandler(async () => {
      effectStarted?.();
      await release;
      return { ok: true };
    });

    const retryPromise = inject(harness.app, idempotencyKey);
    await started;
    await assert.rejects(
      completeIdempotencyKey(staleReservation.id, 200, { stale: true }, staleReservation.ownerId),
      /ownership was lost before completion/,
    );
    releaseEffect?.();

    const retry = await retryPromise;
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.headers['x-idempotency-status'], 'reclaimed');
    assert.deepEqual(retry.json(), { ok: true });
  } finally {
    await cleanup(harness.app, idempotencyKey);
  }
});

test('lease heartbeat prevents reclaim while a long non-atomic effect is active', async () => {
  const suffix = uniqueSuffix();
  const idempotencyKey = `idem-active-heartbeat-${suffix}`;
  const harness = createHeartbeatHarness(`active-heartbeat-${suffix}`, 90);
  let effectCount = 0;
  let effectStarted: (() => void) | undefined;
  let releaseEffect: (() => void) | undefined;
  const started = new Promise<void>(resolve => { effectStarted = resolve; });
  const release = new Promise<void>(resolve => { releaseEffect = resolve; });

  harness.setHandler(async () => {
    effectCount += 1;
    effectStarted?.();
    await release;
    return { ok: true };
  });

  try {
    const firstPromise = inject(harness.app, idempotencyKey);
    await started;
    await new Promise(resolve => setTimeout(resolve, 220));

    harness.setReserveOnly(true);
    const activeRetry = await inject(harness.app, idempotencyKey);
    assert.equal(activeRetry.json<Reservation>().status, 'processing');
    assert.equal(effectCount, 1);

    harness.setReserveOnly(false);
    releaseEffect?.();
    const first = await firstPromise;
    assert.equal(first.statusCode, 200);

    const replay = await inject(harness.app, idempotencyKey);
    assert.equal(replay.headers['x-idempotency-status'], 'replayed');
    assert.deepEqual(replay.json(), { ok: true });
    assert.equal(effectCount, 1);
  } finally {
    releaseEffect?.();
    await cleanup(harness.app, idempotencyKey);
  }
});

function createHarness(scope: string, atomicEffect = true): IdempotencyHarness {
  const app = Fastify({ logger: false });
  let handler: EffectHandler = async () => ({ ok: true });
  let reserveOnly = false;

  app.post('/idempotency-test', async (request, reply) => {
    const options = {
      route: `/idempotency-test/${scope}`,
      method: 'POST',
      body: request.body,
      context: getRequestContext(request),
      atomicEffect,
    };
    if (reserveOnly) return await reserveIdempotentRequest(request, options);
    return await runIdempotentJson(request, reply, options, transaction => handler(transaction));
  });

  return {
    app,
    setHandler: next => { handler = next; },
    setReserveOnly: enabled => { reserveOnly = enabled; },
  };
}

function createHeartbeatHarness(scope: string, leaseDurationMs: number): IdempotencyHarness {
  const app = Fastify({ logger: false });
  let handler: EffectHandler = async () => ({ ok: true });
  let reserveOnly = false;

  app.post('/idempotency-test', async (request, reply) => {
    const reservation = await reserveIdempotentRequest(request, {
      route: `/idempotency-test/${scope}`,
      method: 'POST',
      body: request.body,
      context: getRequestContext(request),
      leaseDurationMs,
    });
    if (reserveOnly || !reservation) return reservation;
    reply.header('x-idempotency-status', reservation.status);
    if (reservation.status === 'processing') return reply.status(409).send({ error: 'processing' });
    if (reservation.status === 'replayed') {
      return reply.status(reservation.responseStatus ?? 200).send(reservation.responseJson);
    }
    if (reservation.status !== 'reserved' && reservation.status !== 'reclaimed') {
      return reply.status(409).send({ error: reservation.status });
    }

    const heartbeat = startIdempotencyLeaseHeartbeat(reservation);
    try {
      const result = await handler();
      await heartbeat.stop();
      await completeIdempotencyKey(reservation.id, 200, result, reservation.ownerId);
      return result;
    } catch (error) {
      await heartbeat.stop();
      throw error;
    }
  });

  return {
    app,
    setHandler: next => { handler = next; },
    setReserveOnly: enabled => { reserveOnly = enabled; },
  };
}

async function inject(app: FastifyInstance, idempotencyKey: string) {
  return await app.inject({
    method: 'POST',
    url: '/idempotency-test',
    headers: { 'x-idempotency-key': idempotencyKey },
    payload: { action: 'approve' },
  });
}

async function loadIdempotencyRow(idempotencyKey: string): Promise<{ status: string } | undefined> {
  const result = await getDb().query<{ status: string }>(
    'SELECT status FROM idempotency_keys WHERE idempotency_key = $1 LIMIT 1',
    [idempotencyKey],
  );
  return result.rows[0];
}

async function cleanup(app: FastifyInstance, idempotencyKey: string): Promise<void> {
  await getDb().query('DELETE FROM idempotency_keys WHERE idempotency_key = $1', [idempotencyKey]).catch(() => undefined);
  await app.close();
}

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
