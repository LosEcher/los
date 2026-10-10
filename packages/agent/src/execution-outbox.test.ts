import test from 'node:test';
import assert from 'node:assert/strict';

import { getDb, withDbClient } from '@los/infra/db';
import {
  publishExecutionOutboxBatch,
  readExecutionOutboxHealth,
  type ExecutionOutboxRecord,
} from './execution-outbox.js';
import { ensureExecutionOutboxStore } from './execution-persistence.js';
import { summarizeDeadLetterEvents } from './dead-letter-recovery.js';
import { ensureDeadLetterStore } from './dead-letter.js';

test('execution outbox retries failed delivery and reports legacy watermark', async () => {
  await ensureExecutionOutboxStore();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `outbox-retry-${suffix}`;
  const eventId = Math.floor(Date.now() / 10);

  try {
    const pendingId = await insertOutboxFixture(sessionId, eventId, false);
    const legacyId = await insertOutboxFixture(sessionId, eventId - 1, true);

    const failed = await publishExecutionOutboxBatch({
      ownerId: 'publisher-a',
      baseDelayMs: 100,
      publish: async () => { throw new Error('notify unavailable'); },
    });
    assert.deepEqual(failed, { claimed: 1, published: 0, retried: 1, deadLettered: 0 });

    const retryRow = await getDb().query<{
      attempts: number;
      last_error: string | null;
      claimed_by: string | null;
      published_at: Date | null;
    }>('SELECT attempts, last_error, claimed_by, published_at FROM execution_outbox WHERE id = $1', [pendingId]);
    assert.equal(retryRow.rows[0]?.attempts, 1);
    assert.equal(retryRow.rows[0]?.last_error, 'notify unavailable');
    assert.equal(retryRow.rows[0]?.claimed_by, null);
    assert.equal(retryRow.rows[0]?.published_at, null);

    const health = await readExecutionOutboxHealth();
    assert.equal(health.pendingCount, 1);
    assert.equal(health.claimedCount, 0);
    assert.equal(health.legacyCount, 1);
    assert.equal(health.legacyThroughId, legacyId);
    assert.ok(health.oldestPendingAgeMs >= 0);

    await getDb().query('UPDATE execution_outbox SET next_attempt_at = now() WHERE id = $1', [pendingId]);
    const delivered: ExecutionOutboxRecord[] = [];
    const succeeded = await publishExecutionOutboxBatch({
      ownerId: 'publisher-a',
      publish: async record => { delivered.push(record); },
    });
    assert.deepEqual(succeeded, { claimed: 1, published: 1, retried: 0, deadLettered: 0 });
    assert.equal(delivered[0]?.sessionEventId, eventId);

    const published = await getDb().query<{ published_at: Date | null; last_error: string | null }>(
      'SELECT published_at, last_error FROM execution_outbox WHERE id = $1',
      [pendingId],
    );
    assert.ok(published.rows[0]?.published_at);
    assert.equal(published.rows[0]?.last_error, null);
  } finally {
    await getDb().query('DELETE FROM execution_outbox WHERE session_id = $1', [sessionId]).catch(() => undefined);
  }
});

test('execution outbox SKIP LOCKED claim prevents concurrent publishers from sharing a row', async () => {
  await ensureExecutionOutboxStore();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `outbox-concurrency-${suffix}`;
  let releasePublish!: () => void;
  let signalClaimed!: () => void;
  const publishBlocked = new Promise<void>(resolve => { releasePublish = resolve; });
  const claimed = new Promise<void>(resolve => { signalClaimed = resolve; });

  try {
    await insertOutboxFixture(sessionId, Math.floor(Date.now() / 10), false);
    const first = publishExecutionOutboxBatch({
      ownerId: 'publisher-first',
      publish: async () => {
        signalClaimed();
        await publishBlocked;
      },
    });
    await claimed;

    const second = await publishExecutionOutboxBatch({
      ownerId: 'publisher-second',
      publish: async () => undefined,
    });
    assert.deepEqual(second, { claimed: 0, published: 0, retried: 0, deadLettered: 0 });

    releasePublish();
    assert.deepEqual(await first, { claimed: 1, published: 1, retried: 0, deadLettered: 0 });
  } finally {
    releasePublish();
    await getDb().query('DELETE FROM execution_outbox WHERE session_id = $1', [sessionId]).catch(() => undefined);
  }
});

async function insertOutboxFixture(sessionId: string, sessionEventId: number, legacy: boolean): Promise<number> {
  const rows = await getDb().query<{ id: string | number }>(`
    INSERT INTO execution_outbox (
      session_id, entity_type, entity_id, event_type, session_event_id, payload_json, legacy
    )
    VALUES ($1, 'task_run', $2, 'task_run.running', $3, '{}'::jsonb, $4)
    RETURNING id
  `, [sessionId, `${sessionId}-entity`, sessionEventId, legacy]);
  return Number(rows.rows[0]?.id);
}

// ── Control-plane §3: the attempt cap hands poison rows to dead_letter_events ──

/** Fixture with a pre-burned attempt count, so the next failure is the terminal one. */
async function insertCappedFixture(options: {
  sessionId: string;
  attempts: number;
  entityType?: string;
  entityId?: string;
  runSpecId?: string | null;
}): Promise<number> {
  const rows = await getDb().query<{ id: string | number }>(`
    INSERT INTO execution_outbox (
      session_id, run_spec_id, entity_type, entity_id, event_type, payload_json, legacy, attempts
    )
    VALUES ($1, $2, $3, $4, 'task_run.running', '{}'::jsonb, FALSE, $5)
    RETURNING id
  `, [
    options.sessionId,
    options.runSpecId ?? null,
    options.entityType ?? 'task_run',
    options.entityId ?? `${options.sessionId}-entity`,
    options.attempts,
  ]);
  return Number(rows.rows[0]?.id);
}

test('outbox retries only the first seven failures; the eighth is terminal', async () => {
  await ensureExecutionOutboxStore();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `outbox-cap-${suffix}`;
  let publishCalls = 0;
  try {
    // Pinned on purpose: the cap is a policy constant in execution-outbox.ts, and
    // the wiring gate rejects exporting it just for tests. Changing the policy must
    // therefore break this test rather than silently move the boundary.
    const id = await insertCappedFixture({ sessionId, attempts: 7 });
    let result = await publishExecutionOutboxBatch({
      ownerId: 'cap-publisher',
      publish: async () => { publishCalls += 1; throw new Error('poison'); },
    });
    assert.deepEqual(result, { claimed: 1, published: 0, retried: 0, deadLettered: 1 });
    assert.equal(publishCalls, 1);

    const capped = await getDb().query<{
      attempts: number;
      dead_lettered_at: Date | null;
      claimed_at: Date | null;
      claimed_by: string | null;
      published_at: Date | null;
      next_attempt_at: Date;
    }>('SELECT attempts, dead_lettered_at, claimed_at, claimed_by, published_at, next_attempt_at FROM execution_outbox WHERE id = $1', [id]);
    const row = capped.rows[0]!;
    assert.equal(row.attempts, 8, 'the terminal attempt is recorded before the cap');
    assert.ok(row.dead_lettered_at, 'capped row carries dead_lettered_at');
    assert.equal(row.claimed_at, null, 'the cap releases the lease');
    assert.equal(row.claimed_by, null);
    assert.equal(row.published_at, null);

    // NEGATIVE CONTROL: the row is out of the claim set for good. The fake publish
    // must not be called a ninth time, and no retry delay may be scheduled.
    const before = row.next_attempt_at instanceof Date ? row.next_attempt_at.getTime() : Date.parse(String(row.next_attempt_at));
    result = await publishExecutionOutboxBatch({
      ownerId: 'cap-publisher',
      publish: async () => { publishCalls += 1; throw new Error('poison'); },
    });
    assert.deepEqual(result, { claimed: 0, published: 0, retried: 0, deadLettered: 0 });
    assert.equal(publishCalls, 1, 'the ninth claim never happens');

    const after = await getDb().query<{ next_attempt_at: Date }>('SELECT next_attempt_at FROM execution_outbox WHERE id = $1', [id]);
    const afterMs = after.rows[0]!.next_attempt_at instanceof Date
      ? after.rows[0]!.next_attempt_at.getTime()
      : Date.parse(String(after.rows[0]!.next_attempt_at));
    assert.equal(afterMs, before, 'the cap must not write a new next_attempt_at');

    // Health projection: a capped row is neither pending nor claimed, but counted.
    const health = await readExecutionOutboxHealth();
    assert.equal(health.deadLetteredCount, 1);
    assert.equal(health.pendingCount, 0, 'a capped row must not inflate pending');
    assert.equal(health.claimedCount, 0, 'a capped row must not look in-flight');
  } finally {
    await getDb().query('DELETE FROM dead_letter_events WHERE event_payload->>\'sessionId\' = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM execution_outbox WHERE session_id = $1', [sessionId]).catch(() => undefined);
  }
});

test('the cap writes exactly one outbox_exhausted dead letter that the summary counts', async () => {
  await ensureExecutionOutboxStore();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `outbox-dlq-${suffix}`;
  try {
    await insertCappedFixture({ sessionId, attempts: 7 });
    await publishExecutionOutboxBatch({
      ownerId: 'cap-publisher',
      publish: async () => { throw new Error('poison'); },
    });

    const rows = await getDb().query<{ id: string; reason: string; acknowledged_at: Date | null; event_payload: Record<string, unknown> }>(
      `SELECT id, reason, acknowledged_at, event_payload FROM dead_letter_events WHERE event_payload->>'sessionId' = $1`,
      [sessionId],
    );
    assert.equal(rows.rows.length, 1, 'exactly one dead-letter row (INSERT succeeded path)');
    assert.equal(rows.rows[0]!.reason, 'outbox_exhausted');
    assert.equal(rows.rows[0]!.acknowledged_at, null, 'a fresh dead letter is unacknowledged');
    assert.equal(Number(rows.rows[0]!.event_payload.attempts), 8, 'payload carries the attempt count');

    // The summary must include it, otherwise the cap reads as "nothing happened".
    const summary = await summarizeDeadLetterEvents();
    assert.ok(summary.byReason.outbox_exhausted, 'summary has an outbox_exhausted bucket');
    assert.ok(summary.byReason.outbox_exhausted.total >= 1);
    assert.ok(summary.total >= 1, 'the fused total must include outbox_exhausted');
  } finally {
    await getDb().query('DELETE FROM dead_letter_events WHERE event_payload->>\'sessionId\' = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM execution_outbox WHERE session_id = $1', [sessionId]).catch(() => undefined);
  }
});

test('the cap applies to dsh_event rows too (forwarder shares the same claim loop)', async () => {
  await ensureExecutionOutboxStore();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `outbox-dsh-cap-${suffix}`;
  try {
    await insertCappedFixture({
      sessionId,
      attempts: 7,
      entityType: 'dsh_event',
      entityId: `dsh-${suffix}`,
    });
    const result = await publishExecutionOutboxBatch({
      ownerId: 'dsh-cap-publisher',
      entityTypes: ['dsh_event'],
      requiresSessionEventId: false,
      publish: async () => { throw new Error('dsh endpoint down'); },
    });
    assert.deepEqual(result, { claimed: 1, published: 0, retried: 0, deadLettered: 1 });

    const rows = await getDb().query<{ reason: string; task_run_id: string | null; run_spec_id: string | null; event_payload: Record<string, unknown> }>(
      `SELECT reason, task_run_id, run_spec_id, event_payload FROM dead_letter_events WHERE event_payload->>'sessionId' = $1`,
      [sessionId],
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]!.reason, 'outbox_exhausted');
    assert.equal(rows.rows[0]!.task_run_id, null);
    assert.equal(rows.rows[0]!.run_spec_id, null);
    assert.equal(rows.rows[0]!.event_payload.entityType, 'dsh_event');
  } finally {
    await getDb().query('DELETE FROM dead_letter_events WHERE event_payload->>\'sessionId\' = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM execution_outbox WHERE session_id = $1', [sessionId]).catch(() => undefined);
  }
});

test('a dangling run_spec_id leaves the FK column NULL but stays visible in the payload', async () => {
  await ensureExecutionOutboxStore();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `outbox-dangling-${suffix}`;
  const danglingRunSpec = `run-spec-does-not-exist-${suffix}`;
  try {
    await insertCappedFixture({ sessionId, attempts: 7, runSpecId: danglingRunSpec });
    await publishExecutionOutboxBatch({
      ownerId: 'cap-publisher',
      publish: async () => { throw new Error('poison'); },
    });

    const rows = await getDb().query<{ run_spec_id: string | null; event_payload: Record<string, unknown> }>(
      `SELECT run_spec_id, event_payload FROM dead_letter_events WHERE event_payload->>'sessionId' = $1`,
      [sessionId],
    );
    assert.equal(rows.rows.length, 1, 'a dangling run_spec_id must not break the INSERT');
    assert.equal(rows.rows[0]!.run_spec_id, null, 'FK column only filled when the target row exists');
    assert.equal(rows.rows[0]!.event_payload.runSpecId, danglingRunSpec, 'the dangling id stays discoverable');
  } finally {
    await getDb().query('DELETE FROM dead_letter_events WHERE event_payload->>\'sessionId\' = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM execution_outbox WHERE session_id = $1', [sessionId]).catch(() => undefined);
  }
});

test('NEGATIVE CONTROL: a failing dead-letter write still commits the cap (SAVEPOINT)', async () => {
  await ensureExecutionOutboxStore();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `outbox-insert-fail-${suffix}`;
  let publishCalls = 0;
  try {
    const id = await insertCappedFixture({ sessionId, attempts: 7 });
    const result = await publishExecutionOutboxBatch({
      ownerId: 'cap-publisher',
      publish: async () => { publishCalls += 1; throw new Error('poison'); },
      // A real server-side error on the transaction client — the same class of
      // failure a broken INSERT produces. Without the SAVEPOINT the transaction
      // would be aborted and the COMMIT rejected, leaving the poison row
      // claimable; with it, the cap must survive.
      writeDeadLetter: async () => { throw new Error('insert exploded'); },
    });
    assert.deepEqual(result, { claimed: 1, published: 0, retried: 0, deadLettered: 1 });

    const capped = await getDb().query<{ dead_lettered_at: Date | null; claimed_at: Date | null }>(
      'SELECT dead_lettered_at, claimed_at FROM execution_outbox WHERE id = $1',
      [id],
    );
    assert.ok(capped.rows[0]!.dead_lettered_at, 'the cap survived the failed write');
    assert.equal(capped.rows[0]!.claimed_at, null);

    const dlq = await getDb().query(
      `SELECT 1 FROM dead_letter_events WHERE event_payload->>'sessionId' = $1`,
      [sessionId],
    );
    assert.equal(dlq.rows.length, 0, 'the dead-letter row may legitimately be zero here');

    const again = await publishExecutionOutboxBatch({
      ownerId: 'cap-publisher',
      publish: async () => { publishCalls += 1; throw new Error('poison'); },
    });
    assert.deepEqual(again, { claimed: 0, published: 0, retried: 0, deadLettered: 0 });
    assert.equal(publishCalls, 1, 'the capped row is never claimed again');
  } finally {
    await getDb().query('DELETE FROM dead_letter_events WHERE event_payload->>\'sessionId\' = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM execution_outbox WHERE session_id = $1', [sessionId]).catch(() => undefined);
  }
});

test('NEGATIVE CONTROL: a failed attempt below the cap still honours backoff and the lease', async () => {
  await ensureExecutionOutboxStore();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `outbox-backoff-${suffix}`;
  let publishCalls = 0;
  try {
    const id = await insertCappedFixture({ sessionId, attempts: 0, entityType: 'dsh_event', entityId: `x-${suffix}` });
    const failed = await publishExecutionOutboxBatch({
      ownerId: 'backoff-publisher',
      entityTypes: ['dsh_event'],
      requiresSessionEventId: false,
      baseDelayMs: 60_000,
      publish: async () => { publishCalls += 1; throw new Error('poison'); },
    });
    assert.deepEqual(failed, { claimed: 1, published: 0, retried: 1, deadLettered: 0 });

    // Waiting out the backoff: next_attempt_at is in the future, so no claim.
    const tooEarly = await publishExecutionOutboxBatch({
      ownerId: 'backoff-publisher',
      entityTypes: ['dsh_event'],
      requiresSessionEventId: false,
      publish: async () => { publishCalls += 1; },
    });
    assert.deepEqual(tooEarly, { claimed: 0, published: 0, retried: 0, deadLettered: 0 }, 'backoff must still hold rows out');

    // A live lease holds the row even when the backoff has elapsed.
    await getDb().query(
      `UPDATE execution_outbox SET next_attempt_at = now() - interval '1 second', claimed_at = now() WHERE id = $1`,
      [id],
    );
    const leased = await publishExecutionOutboxBatch({
      ownerId: 'backoff-publisher',
      entityTypes: ['dsh_event'],
      requiresSessionEventId: false,
      publish: async () => { publishCalls += 1; throw new Error('poison'); },
    });
    assert.deepEqual(leased, { claimed: 0, published: 0, retried: 0, deadLettered: 0 }, 'the claim lease must still hold');
    assert.equal(publishCalls, 1);
  } finally {
    await getDb().query('DELETE FROM dead_letter_events WHERE event_payload->>\'sessionId\' = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM execution_outbox WHERE session_id = $1', [sessionId]).catch(() => undefined);
  }
});
