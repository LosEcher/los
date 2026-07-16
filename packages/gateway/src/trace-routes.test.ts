import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, initDb } from '@los/infra/db';
import { appendSessionEvent, ensureSessionEventStore, ensureSessionStore, saveSession } from '@los/agent';
import {
  buildGoldenSessionTraceSession,
  GOLDEN_SESSION_TRACE_EVENT_WRITES,
  GOLDEN_SESSION_TRACE_MESSAGES_VIEW,
} from '@los/agent/session-trace-fixtures';
import { GOLDEN_EXECUTION_OBSERVABILITY_FIXTURES } from '@los/agent/execution-observability-fixtures';
import { createServer } from './server.js';

test('execution observability route projects persisted versions and waterfall evidence', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `execution-observability-route-${suffix}`;
  const fixture = GOLDEN_EXECUTION_OBSERVABILITY_FIXTURES.find(item => item.name === 'success')!;
  const app = await createServer({
    serviceId: `gateway-execution-observability-test-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });

  try {
    await ensureSessionEventStore();
    for (const fixtureEvent of fixture.events) {
      await appendSessionEvent({
        sessionId,
        turn: fixtureEvent.turn,
        type: fixtureEvent.type,
        source: fixtureEvent.source,
        model: fixtureEvent.model,
        toolName: fixtureEvent.toolName,
        usage: fixtureEvent.usage,
        payload: fixtureEvent.payload,
      });
    }

    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${sessionId}/execution-observability`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.sessionId, sessionId);
    assert.equal(body.fingerprint.status, 'known');
    assert.equal(body.fingerprint.hash, fixture.expected.fingerprint.hash);
    assert.equal(body.waterfall[0].modelWait.durationMs, 120);
    assert.equal(body.waterfall[0].toolWait.durationMs, 30);
    assert.equal(body.waterfall[0].tokens.totalTokens, 15);
    assert.deepEqual(body.failureFacets, []);
  } finally {
    await app.close();
    await closeDb();
  }
});

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

test('session trace route matches golden view-model fixture', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-trace-golden-${suffix}`;

  const app = await createServer({
    serviceId: `gateway-trace-golden-test-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });

  try {
    await ensureSessionStore();
    await ensureSessionEventStore();
    await saveSession(buildGoldenSessionTraceSession(sessionId));
    for (const event of GOLDEN_SESSION_TRACE_EVENT_WRITES) {
      await appendSessionEvent({ sessionId, ...event });
    }

    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${sessionId}/trace`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.sessionId, sessionId);
    assert.equal(body.turnCount, 1);
    assert.equal(body.messageCount, 2);
    assert.deepEqual(body.messages, GOLDEN_SESSION_TRACE_MESSAGES_VIEW);
  } finally {
    await app.close();
    await closeDb();
  }
});
