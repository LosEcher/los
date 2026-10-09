/**
 * dsh-event-outbox 的库内测试：走**公开** API（enqueueDshEvent / publishDshEventsBatch /
 * readDshEventOutboxHealth），验证 P1-a 的四条判据：
 *   幂等入队 · 死 URL 只记重试不标已投递 · 真 URL 落 published_at · 健康面计数。
 * 需要 DB（隔离分组）；传输语义靠注入 fetchImpl 覆盖，不碰真网络。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { initDb, closeDb, getDb } from '@los/infra/db';
import { ensureExecutionOutboxStore } from './execution-persistence.js';
import {
  enqueueDshEvent,
  publishDshEventsBatch,
  readDshEventOutboxHealth,
} from './dsh-event-outbox.js';

const TYPE = 'governance.job.escalated';

function uniqueEventId(tag: string): string {
  return `test-dsh-event-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface OutboxRow {
  attempts: number | string;
  last_error: string | null;
  published_at: string | Date | null;
  event_type: string;
}

async function rowFor(eventId: string): Promise<OutboxRow | undefined> {
  const rows = await getDb().query<OutboxRow>(
    'SELECT attempts, last_error, published_at, event_type FROM execution_outbox WHERE entity_type = $1 AND entity_id = $2',
    ['dsh_event', eventId],
  );
  return rows.rows[0];
}

const num = (value: number | string | null | undefined): number => Number(value ?? 0);
const isPublished = (row: OutboxRow | undefined): boolean => row?.published_at != null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let dbReady = false;
async function ensureDb(): Promise<void> {
  if (dbReady) return;
  await initDb();
  await ensureExecutionOutboxStore();
  dbReady = true;
}

test('enqueue is idempotent per eventId (同 eventId 只入队一次)', async () => {
  await ensureDb();
  const eventId = uniqueEventId('dedupe');
  const first = await enqueueDshEvent({ eventId, type: TYPE, payload: { jobType: 'probe-a' } });
  const second = await enqueueDshEvent({ eventId, type: TYPE, payload: { jobType: 'probe-a' } });
  assert.equal(first.enqueued, true);
  assert.equal(second.enqueued, false);
  const row = await rowFor(eventId);
  assert.equal(row?.event_type, TYPE);
  assert.equal(num(row?.attempts), 0);
  assert.equal(isPublished(row), false);
});

test('dead endpoint records a retry and never marks the event published', async () => {
  await ensureDb();
  const eventId = uniqueEventId('dead');
  await enqueueDshEvent({ eventId, type: TYPE, payload: { jobType: 'probe-b' } });
  const result = await publishDshEventsBatch({
    ownerId: 'test-dsh-event-outbox',
    url: 'http://127.0.0.1:1/los-events',
    baseDelayMs: 200,
    fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
  });
  // 批次里可能还夹着其它测试留下的 dsh 行（共享开发库手动跑时），故按"本行"断言；
  // 隔离测试库里本行就是唯一候选。
  assert.ok(result.retried >= 1, 'dead endpoint must produce at least one retry');
  const row = await rowFor(eventId);
  assert.equal(num(row?.attempts) >= 1, true);
  assert.equal(isPublished(row), false);
  assert.match(String(row?.last_error), /ECONNREFUSED/);
});

test('non-2xx and non-JSON answers are treated as failures (不得当成已投递)', async () => {
  await ensureDb();
  for (const [tag, impl] of [
    ['http500', async () => jsonResponse({ error: 'boom' }, 500)],
    ['html', async () => new Response('<html>splash</html>', { status: 200 })],
  ] as const) {
    const eventId = uniqueEventId(tag);
    await enqueueDshEvent({ eventId, type: TYPE, payload: { jobType: `probe-${tag}` } });
    const result = await publishDshEventsBatch({
      ownerId: 'test-dsh-event-outbox',
      url: 'http://127.0.0.1:1/los-events',
      baseDelayMs: 200,
      fetchImpl: impl as unknown as typeof fetch,
    });
    assert.ok(result.retried >= 1, `${tag} should retry`);
    const row = await rowFor(eventId);
    assert.equal(isPublished(row), false, `${tag} must stay unpublished`);
    assert.ok(row?.last_error, `${tag} must record last_error`);
  }
});

test('handled:true marks published; handled:false is delivered-but-declined (no retry)', async () => {
  await ensureDb();
  const delivered = uniqueEventId('delivered');
  await enqueueDshEvent({ eventId: delivered, type: TYPE, payload: { jobType: 'probe-c' } });
  const ok = await publishDshEventsBatch({
    ownerId: 'test-dsh-event-outbox',
    url: 'http://127.0.0.1:1/los-events',
    fetchImpl: (async () => jsonResponse({ handled: true, pushed: false, reason: 'state unchanged (fingerprint match)' })) as unknown as typeof fetch,
  });
  assert.ok(ok.published >= 1);
  const rowOk = await rowFor(delivered);
  assert.equal(isPublished(rowOk), true);
  assert.equal(rowOk?.last_error, null);

  const declined = uniqueEventId('declined');
  await enqueueDshEvent({ eventId: declined, type: TYPE, payload: { jobType: 'probe-d' } });
  const res = await publishDshEventsBatch({
    ownerId: 'test-dsh-event-outbox',
    url: 'http://127.0.0.1:1/los-events',
    fetchImpl: (async () => jsonResponse({ handled: false, pushed: false, reason: 'not governance (x)' })) as unknown as typeof fetch,
  });
  const rowDeclined = await rowFor(declined);
  assert.equal(isPublished(rowDeclined), true, 'declined events must not spin in retry');
  assert.ok(res.claimed >= 1);
});

test('health counts published/pending/failed for dsh events only', async () => {
  await ensureDb();
  const eventId = uniqueEventId('health');
  await enqueueDshEvent({ eventId, type: TYPE, payload: { jobType: 'probe-e' } });
  const health = await readDshEventOutboxHealth();
  assert.ok(health.pending + health.claimed + health.published >= 1);
  assert.ok(health.failed >= 0);
  assert.ok(health.oldestPendingAgeMs >= 0);
});

test.after(async () => {
  if (dbReady) await closeDb();
});
