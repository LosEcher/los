import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, initDb } from '@los/infra/db';
import { appendSessionEvent, ensureSessionEventStore, ensureSessionStore, saveSession } from '@los/agent';
import { createServer } from './server.js';

test('session trace route renders assistant tool cards from ledger', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-trace-${suffix}`;
  const callId = `call-${suffix}`;

  const app = await createServer({
    serviceId: `gateway-trace-test-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });

  try {
    await ensureSessionStore();
    await ensureSessionEventStore();

    await saveSession({
      id: sessionId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
      messages: [
        { role: 'user', content: 'hi' } as any,
        {
          role: 'assistant',
          content: 'ok',
          tool_calls: [{ id: callId, type: 'function', function: { name: 'read_file', arguments: '{"path":"/etc/hosts"}' } }],
        } as any,
      ],
      turns: [
        { loopCount: 1, text: 'ok', toolCalls: [], toolResults: [], reasoningContent: 'reason' } as any,
      ],
    });

    await appendSessionEvent({
      sessionId,
      type: 'model.response',
      turn: 1,
      model: 'test-model',
      payload: { provider: 'test', durationMs: 12 },
    });

    await appendSessionEvent({
      sessionId,
      type: 'tool.call',
      turn: 1,
      toolName: 'read_file',
      payload: { callId, args: { path: '/etc/hosts' } },
    });

    await appendSessionEvent({
      sessionId,
      type: 'tool.result',
      turn: 1,
      toolName: 'read_file',
      payload: { callId, ok: true, durationMs: 34, attempts: 1, contentPreview: '127.0.0.1 localhost', contentLength: 18 },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${sessionId}/trace`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.sessionId, sessionId);
    assert.equal(body.turnCount, 1);
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[1].role, 'assistant');
    assert.equal(body.messages[1].toolCalls.length, 1);
    assert.equal(body.messages[1].toolCalls[0].callId, callId);
    assert.equal(body.messages[1].toolCalls[0].toolName, 'read_file');
    assert.equal(body.messages[1].toolCalls[0].status, 'completed');
    assert.equal(body.messages[1].toolCalls[0].resultPreview, '127.0.0.1 localhost');
  } finally {
    await app.close();
    await closeDb();
  }
});

test('session trace route falls back to events when session transcript is empty', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-trace-fallback-${suffix}`;
  const callId = `call-${suffix}`;

  const app = await createServer({
    serviceId: `gateway-trace-fallback-test-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });

  try {
    await ensureSessionStore();
    await ensureSessionEventStore();

    await saveSession({
      id: sessionId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: { prompt: 'hello fallback' } as any,
      messages: [],
      turns: [],
    });

    await appendSessionEvent({
      sessionId,
      type: 'model.response',
      turn: 1,
      model: 'test-model',
      payload: { provider: 'test', textPreview: '', reasoningPreview: '' },
    });

    await appendSessionEvent({
      sessionId,
      type: 'tool.call',
      turn: 1,
      toolName: 'read_file',
      payload: { callId, args: { path: '/etc/hosts' } },
    });

    await appendSessionEvent({
      sessionId,
      type: 'tool.result',
      turn: 1,
      toolName: 'read_file',
      payload: { callId, ok: true, contentPreview: '127.0.0.1 localhost' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${sessionId}/trace`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.sessionId, sessionId);
    assert.equal(body.turnCount, 1);
    assert.equal(body.messages[0].role, 'user');
    assert.equal(body.messages[0].content, 'hello fallback');
    assert.equal(body.messages[1].role, 'assistant');
    assert.equal(body.messages[1].toolCalls[0].callId, callId);
  } finally {
    await app.close();
    await closeDb();
  }
});
