import test from 'node:test';
import assert from 'node:assert/strict';

import { getDb } from '@los/infra/db';
import {
  publishExecutionOutboxBatch,
  readExecutionOutboxHealth,
  type ExecutionOutboxRecord,
} from './execution-outbox.js';
import { ensureExecutionOutboxStore } from './execution-persistence.js';

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
    assert.deepEqual(failed, { claimed: 1, published: 0, retried: 1 });

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
    assert.deepEqual(succeeded, { claimed: 1, published: 1, retried: 0 });
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
    assert.deepEqual(second, { claimed: 0, published: 0, retried: 0 });

    releasePublish();
    assert.deepEqual(await first, { claimed: 1, published: 1, retried: 0 });
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
