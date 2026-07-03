/**
 * Worker Messages tests — verifies message types, store lifecycle, and dispatch scoping.
 *
 * Run with the same setup as other @los/agent DB-backed tests.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import {
  ensureWorkerMessageStore,
  sendWorkerMessage,
  sendHeartbeat,
  listMessagesForDispatch,
  listMessagesForTask,
  hasWorkerDone,
} from './worker-messages.js';

describe('worker messages', () => {
  before(async () => {
    const config = await loadConfig();
    await initDb(config.databaseUrl);
    await ensureWorkerMessageStore();
  });

  after(async () => {
    await closeDb();
  });

  it('sendWorkerMessage persists a worker_done with summary', async () => {
    const msg = await sendWorkerMessage({
      dispatchId: randomUUID(),
      taskId: randomUUID(),
      type: 'worker_done',
      payload: { summary: 'completed billing audit', files_modified: ['billing.tsx'] },
    });
    assert.ok(msg.id);
    assert.equal(msg.type, 'worker_done');
    assert.equal(msg.payload.summary, 'completed billing audit');
    assert.deepEqual(msg.payload.files_modified, ['billing.tsx']);
  });

  it('sendHeartbeat shortcut creates a heartbeat message', async () => {
    const msg = await sendHeartbeat({
      dispatchId: randomUUID(),
      phase: 'executing',
      metadata: { progress: 0.5 },
    });
    assert.equal(msg.type, 'heartbeat');
    assert.equal(msg.payload.phase, 'executing');
  });

  it('listMessagesForDispatch filters by type and limits', async () => {
    const dispatchId = randomUUID();
    await sendWorkerMessage({ dispatchId, type: 'heartbeat', payload: { phase: 'one' } });
    await sendWorkerMessage({ dispatchId, type: 'ask', payload: { question: 'merge?' } });
    await sendWorkerMessage({ dispatchId, type: 'heartbeat', payload: { phase: 'two' } });

    const heartbeats = await listMessagesForDispatch(dispatchId, { type: 'heartbeat' });
    assert.equal(heartbeats.length, 2);
    assert(heartbeats.every(m => m.type === 'heartbeat'));

    const limited = await listMessagesForDispatch(dispatchId, { limit: 1 });
    assert.equal(limited.length, 1);
  });

  it('listMessagesForTask spans all dispatches for a task', async () => {
    const taskId = randomUUID();
    await sendWorkerMessage({ dispatchId: randomUUID(), taskId, type: 'heartbeat', payload: {} });
    await sendWorkerMessage({ dispatchId: randomUUID(), taskId, type: 'worker_done', payload: { summary: 'done' } });

    const msgs = await listMessagesForTask(taskId);
    assert.equal(msgs.length, 2);
  });

  it('hasWorkerDone returns false before worker_done, true after', async () => {
    const dispatchId = randomUUID();
    assert.equal(await hasWorkerDone(dispatchId), false);
    await sendWorkerMessage({ dispatchId, type: 'worker_done', payload: { summary: 'done' } });
    assert.equal(await hasWorkerDone(dispatchId), true);
  });

  it('escalation message carries reason', async () => {
    const msg = await sendWorkerMessage({
      dispatchId: randomUUID(),
      type: 'escalation',
      payload: { reason: 'missing API credentials' },
    });
    assert.equal(msg.type, 'escalation');
    assert.equal(msg.payload.reason, 'missing API credentials');
  });

  it('ask message carries question and options', async () => {
    const msg = await sendWorkerMessage({
      dispatchId: randomUUID(),
      type: 'ask',
      payload: { question: 'Update shared component or only this page?', options: ['shared', 'page-only'] },
    });
    assert.equal(msg.type, 'ask');
    assert.ok(msg.payload.options?.includes('shared'));
  });

  it('worker_messages type CHECK rejects invalid types', async () => {
    await assert.rejects(
      () => getDb().query(
        `INSERT INTO worker_messages (id, type, payload_json) VALUES ($1, 'invalid_type', '{}')`,
        [randomUUID()],
      ),
      /worker_messages_type_chk|violates check constraint/,
    );
  });
});
