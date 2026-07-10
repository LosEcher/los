import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import WebSocket from 'ws';
import type { MessagePrincipal } from '@los/agent/message-router';
import { ensureSessionEventStore, listSessionEvents } from '@los/agent/session-events';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { loadConfig, setConfig } from '@los/infra/config';
import authMiddleware from '../../auth-middleware.js';
import { registerRequestContext } from '../../request-context.js';
import { handleWsControlMessage } from './ws-control.js';
import { registerWsRoutes } from './ws-routes.js';

test('WS steering rejects anonymous and authenticated principals with zero writes', async () => {
  const deniedPrincipals: MessagePrincipal[] = [
    { kind: 'anonymous', subject: 'anonymous', authenticatedBy: 'none', capabilities: [] },
    {
      kind: 'authenticated', subject: 'authenticated:shared-token',
      authenticatedBy: 'access_token', capabilities: [],
    },
  ];
  let writes = 0;
  for (const principal of deniedPrincipals) {
    const events: Array<{ event: string; data: unknown }> = [];
    await handleWsControlMessage(Buffer.from('{"type":"steering","instruction":"approve"}'), {
      principal,
      sessionId: 'session-abc12345',
      send: (event, data) => events.push({ event, data }),
      recordSteering: async () => {
        writes += 1;
        return {} as never;
      },
    });
    assert.deepEqual(events, [{ event: 'error', data: { error: 'operator_required' } }]);
  }
  assert.equal(writes, 0);
});

test('WS steering writes the trusted operator principal subject', async () => {
  let actor: string | undefined;
  const events: Array<{ event: string; data: unknown }> = [];
  await handleWsControlMessage(Buffer.from('{"type":"steering","instruction":"approve"}'), {
    principal: {
      kind: 'operator', subject: 'operator:shared-token',
      authenticatedBy: 'operator_token', capabilities: ['session:steer'],
      userId: 'forged-name',
    },
    sessionId: 'session-abc12345',
    send: (event, data) => events.push({ event, data }),
    recordSteering: async input => {
      actor = input.actor;
      return { id: 42, type: 'operator.steering' } as never;
    },
  });
  assert.equal(actor, 'operator:shared-token');
  assert.equal(events[0]?.event, 'steering.ack');
});

test('WS upgrade enforces transport auth and wires trusted steering actor', async () => {
  const baseConfig = await loadConfig();
  const config = {
    ...baseConfig,
    auth: { enabled: true, token: 'access-token', operatorToken: 'operator-token' },
  };
  setConfig(config);
  await initDb(config.databaseUrl);
  await ensureSessionEventStore();

  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  registerRequestContext(app, config);
  await authMiddleware(app, { config });
  registerWsRoutes(app, 'gateway-ws-auth-test');

  const ordinarySessionId = `session-ws-ordinary-${Date.now()}`;
  const operatorSessionId = `session-ws-operator-${Date.now()}`;

  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const wsBase = address.replace(/^http/, 'ws');
    const anonymousStatus = await rejectedUpgradeStatus(`${wsBase}/sessions/session-ws-anonymous/stream/ws`);
    assert.equal(anonymousStatus, 401);

    const ordinary = await openWebSocket(
      `${wsBase}/sessions/${ordinarySessionId}/stream/ws`,
      { 'x-los-auth-token': 'access-token' },
    );
    await waitForControlReady(ordinary);
    const denied = await sendControl(ordinary, { type: 'steering', instruction: 'approve' });
    assert.deepEqual(denied, { event: 'error', data: { error: 'operator_required' } });
    await closeWebSocket(ordinary);
    assert.equal((await listSessionEvents(ordinarySessionId)).length, 0);

    const operator = await openWebSocket(
      `${wsBase}/sessions/${operatorSessionId}/stream/ws`,
      { 'x-los-operator-token': 'operator-token', 'x-user-id': 'forged-name' },
    );
    await waitForControlReady(operator);
    const acknowledged = await sendControl(operator, { type: 'steering', instruction: 'approve' });
    assert.equal(acknowledged.event, 'steering.ack');
    await closeWebSocket(operator);

    const events = await listSessionEvents(operatorSessionId);
    const steering = events.find(event => event.type === 'operator.steering');
    assert.ok(steering);
    assert.equal(steering.payload.actor, 'operator:shared-token');
  } finally {
    await app.close();
    for (const sessionId of [ordinarySessionId, operatorSessionId]) {
      await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
      await getDb().query('DELETE FROM stream_leases WHERE session_id = $1', [sessionId]).catch(() => undefined);
    }
    await closeDb().catch(() => undefined);
  }
});

function openWebSocket(url: string, headers: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function rejectedUpgradeStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('unexpected-response', (_request, response) => {
      const statusCode = response.statusCode ?? 0;
      response.destroy();
      resolve(statusCode);
    });
    socket.once('open', () => reject(new Error('anonymous WebSocket upgrade unexpectedly succeeded')));
    socket.once('error', reject);
  });
}

function sendControl(socket: WebSocket, message: Record<string, unknown>): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for WebSocket control response')), 5_000);
    socket.once('message', raw => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()) as Record<string, any>);
    });
    socket.send(JSON.stringify(message));
  });
}

function waitForControlReady(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('timed out waiting for WebSocket control readiness')), 5_000);
    const interval = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.send('{"type":"ping"}');
    }, 25);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as { event?: string };
      if (message.event === 'pong') finish();
    };
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      clearInterval(interval);
      socket.off('message', onMessage);
      if (error) reject(error);
      else resolve();
    };
    socket.on('message', onMessage);
    socket.send('{"type":"ping"}');
  });
}

function closeWebSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === socket.CLOSED) return Promise.resolve();
  return new Promise(resolve => {
    socket.once('close', () => resolve());
    socket.close();
  });
}
