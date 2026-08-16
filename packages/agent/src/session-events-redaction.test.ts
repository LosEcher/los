import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendSessionEvent,
  appendSessionEvents,
  listSessionEvents,
  listSessionEventsBefore,
  listSessionEventsSince,
} from './session-events.js';

function uniqueSessionId(): string {
  return `redaction-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

test('appendSessionEvent persists redacted payload (secret keys) and truncates long strings', async () => {
  const sessionId = uniqueSessionId();
  const long = 'x'.repeat(2500);
  await appendSessionEvent({
    sessionId,
    type: 'tool.result',
    payload: {
      ok: true,
      apiKey: 'sk-live-1',
      nested: { authorization: 'Bearer abc' },
      contentPreview: long,
      keep: 'visible',
    },
  });
  const [event] = await listSessionEvents(sessionId, 10);
  assert.ok(event, 'event should be persisted');
  assert.equal(event.payload.apiKey, '[redacted]');
  assert.equal((event.payload.nested as Record<string, unknown>).authorization, '[redacted]');
  assert.equal(event.payload.keep, 'visible');
  assert.equal(String(event.payload.contentPreview).length, 2000 + '…[truncated]'.length);
});

test('appendSessionEvent redacts embedded secret shapes in telemetry-facing strings', async () => {
  const sessionId = uniqueSessionId();
  await appendSessionEvent({
    sessionId,
    type: 'model.response',
    payload: {
      textPreview: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig done',
      endpoint: 'https://api.example.com/v1/chat?api_key=sk-live-1&model=x',
    },
  });
  const [event] = await listSessionEvents(sessionId, 10);
  assert.ok(!String(event.payload.textPreview).includes('eyJhbGciOiJIUzI1NiJ9'));
  assert.ok(!String(event.payload.endpoint).includes('sk-live-1'));
  assert.ok(String(event.payload.endpoint).includes('[redacted]'));
});

test('appendSessionEvents batch applies the same redaction waterfall', async () => {
  const sessionId = uniqueSessionId();
  await appendSessionEvents([
    { sessionId, type: 'tool.call', payload: { callId: 'c1', apiKey: 'sk-1' } },
    { sessionId, type: 'tool.result', payload: { callId: 'c1', ok: true, token: 't-1' } },
  ]);
  const events = await listSessionEvents(sessionId, 10);
  assert.equal(events.length, 2);
  assert.equal(events[0].payload.apiKey, '[redacted]');
  assert.equal(events[1].payload.token, '[redacted]');
});

test('listSessionEventsSince / listSessionEventsBefore support incremental windows', async () => {
  const sessionId = uniqueSessionId();
  await appendSessionEvents([
    { sessionId, type: 'session.started', payload: { promptPreview: 'p1' } },
    { sessionId, type: 'model.response', payload: { textPreview: 'r1' } },
    { sessionId, type: 'tool.call', payload: { callId: 'c1' } },
    { sessionId, type: 'tool.result', payload: { callId: 'c1', ok: true } },
  ]);
  const all = await listSessionEvents(sessionId, 10);
  const firstId = all[0].id;
  const lastId = all[all.length - 1].id;

  const since = await listSessionEventsSince(sessionId, firstId, 10);
  assert.equal(since.length, 3);
  assert.ok(since.every(e => e.id > firstId));

  const before = await listSessionEventsBefore(sessionId, lastId, 10);
  assert.equal(before.length, 3);
  assert.ok(before.every(e => e.id < lastId));
  assert.ok(before[0].id < before[1].id, 'window returned ascending for prepend');
});
