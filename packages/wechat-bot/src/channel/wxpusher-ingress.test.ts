import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { MessageRouter, type RouteResult } from '@los/agent/message-router';
import { getDb } from '@los/infra/db';
import { createWeixinChannel, type WeixinChannelConfig } from './weixin.js';
import type { UnifiedMessage } from './types.js';
import { authenticatedWxPusherIdentity } from './wxpusher-ingress.js';
import { routeTrustedWxPusherMessage } from '../wxpusher-routing.js';
import { createWxPusherInboundHandler } from '../wxpusher-inbound-handler.js';

const HOST = '127.0.0.1';
const APP_ID = 12345;
const OPERATOR_UID = 'UID_operator';
const PROXY_SECRET = '0123456789abcdef0123456789abcdef';
const CALLBACK_TOKEN = 'abcdef0123456789abcdef0123456789';

test('WxPusher up-call is disabled by default', async () => {
  const port = await reservePort();
  let handlerCalls = 0;
  const channel = createWeixinChannel(baseConfig(port, { upCallEnabled: false }));
  channel.onMessage(() => { handlerCalls += 1; });

  assert.equal(channel.capabilities.upCall, false);
  await channel.start();
  try {
    const response = await callbackRequest(port, validBody());
    assert.equal(response.status, 404);
    assert.equal(handlerCalls, 0);
  } finally {
    await channel.stop();
  }
});

test('WxPusher up-call refuses incomplete security config and non-loopback binds', () => {
  assert.throws(
    () => createWeixinChannel(baseConfig(8900, { callbackToken: undefined })),
    /LOS_WXPUSHER_CALLBACK_TOKEN/,
  );
  assert.throws(
    () => createWeixinChannel(baseConfig(8900, { callbackHost: '0.0.0.0' })),
    /loopback/,
  );
});

test('forged, malformed, stale, future, and oversized callbacks never reach handlers', async () => {
  const port = await reservePort();
  let handlerCalls = 0;
  const logEntries: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const channel = createWeixinChannel(baseConfig(port, {
    callbackLogger: {
      warn: (message, meta) => { logEntries.push({ message, meta }); },
    },
  }));
  channel.onMessage(() => { handlerCalls += 1; });

  await channel.start();
  try {
    assert.equal((await callbackRequest(port, validBody(), { token: null })).status, 401);
    assert.equal((await callbackRequest(port, validBody(), { token: 'wrong-token' })).status, 401);
    assert.equal((await callbackRequest(port, validBody(), { secret: 'wrong-secret' })).status, 401);
    assert.equal((await callbackRequest(port, '{not-json')).status, 400);
    assert.equal((await callbackRequest(port, { ...validBody(), action: 'unknown_action' })).status, 422);
    assert.equal((await callbackRequest(port, validBody({ appId: APP_ID + 1 }))).status, 403);
    assert.equal((await callbackRequest(port, validBody({ uid: 'UID_untrusted' }))).status, 403);
    assert.equal((await callbackRequest(port, validBody({ time: Date.now() - 120_000 }))).status, 409);
    assert.equal((await callbackRequest(port, validBody({ time: Date.now() + 6_000 }))).status, 409);
    assert.equal((await callbackRequest(port, validBody({ content: 'x'.repeat(2_000) }))).status, 413);
    assert.equal(handlerCalls, 0);
    const logged = JSON.stringify(logEntries);
    assert.equal(logged.includes(PROXY_SECRET), false);
    assert.equal(logged.includes(CALLBACK_TOKEN), false);
    assert.equal(logged.includes('UID_untrusted'), false);
    assert.equal(logged.includes('x'.repeat(64)), false);
  } finally {
    await channel.stop();
  }
});

test('PostgreSQL replay claim is atomic across instances and survives restart', async () => {
  const body = validBody({ content: `#status ${randomUUID()}` });
  const firstPort = await reservePort();
  const secondPort = await reservePort();
  let firstHandlerCalls = 0;
  let secondHandlerCalls = 0;
  const firstChannel = createWeixinChannel(baseConfig(firstPort));
  const secondChannel = createWeixinChannel(baseConfig(secondPort));
  firstChannel.onMessage(() => { firstHandlerCalls += 1; });
  secondChannel.onMessage(() => { secondHandlerCalls += 1; });

  await firstChannel.start();
  await secondChannel.start();
  try {
    const responses = await Promise.all([
      callbackRequest(firstPort, body),
      callbackRequest(secondPort, body),
    ]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    assert.equal(firstHandlerCalls + secondHandlerCalls, 1);
  } finally {
    await firstChannel.stop();
    await secondChannel.stop();
  }

  const restartedPort = await reservePort();
  let restartedHandlerCalls = 0;
  const restartedChannel = createWeixinChannel(baseConfig(restartedPort));
  restartedChannel.onMessage(() => { restartedHandlerCalls += 1; });
  await restartedChannel.start();
  try {
    assert.equal((await callbackRequest(restartedPort, body)).status, 409);
    assert.equal(restartedHandlerCalls, 0);
  } finally {
    await restartedChannel.stop();
  }
});

test('future event retention remains claimed until eventTime plus maxAge', async () => {
  const port = await reservePort();
  const eventTime = Date.now() + 800;
  const body = validBody({ time: eventTime, content: `#status ${randomUUID()}` });
  let handlerCalls = 0;
  const channel = createWeixinChannel(baseConfig(port, {
    callbackMaxAgeMs: 2_000,
    callbackMaxFutureSkewMs: 1_000,
  }));
  channel.onMessage(() => { handlerCalls += 1; });

  await channel.start();
  try {
    assert.equal((await callbackRequest(port, body)).status, 200);
    await delay(2_100);
    assert.equal((await callbackRequest(port, body)).status, 409);
    assert.equal(handlerCalls, 1);
  } finally {
    await channel.stop();
  }
});

test('cleanup preserves accepted audit state while a long handler crosses expiresAt', async () => {
  const port = await reservePort();
  const originalContent = `#status long-${randomUUID()}`;
  const originalBody = validBody({ content: originalContent });
  let originalReplayKey = '';
  let sideEffects = 0;
  let notifyStarted!: () => void;
  let unblockHandler!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const handlerBlock = new Promise<void>(resolve => { unblockHandler = resolve; });
  const channel = createWeixinChannel(baseConfig(port, {
    callbackMaxAgeMs: 1_000,
    callbackMaxFutureSkewMs: 100,
  }));
  channel.onMessage(async message => {
    if (message.text !== originalContent) return;
    sideEffects += 1;
    originalReplayKey = authenticatedWxPusherIdentity(message)?.replayKey ?? '';
    notifyStarted();
    await handlerBlock;
  });

  await channel.start();
  try {
    const originalResponse = callbackRequest(port, originalBody);
    await started;
    await delay(1_100);

    const cleanupBody = validBody({ content: `#status cleanup-${randomUUID()}` });
    assert.equal((await callbackRequest(port, cleanupBody)).status, 200);
    assert.notEqual(originalReplayKey, '');
    const accepted = await getDb().query<{ state: string; is_expired: boolean }>(
      `SELECT state, expires_at <= now() AS is_expired
       FROM wxpusher_callback_claims WHERE replay_key = $1`,
      [originalReplayKey],
    );
    assert.deepEqual(accepted.rows[0], { state: 'accepted', is_expired: true });

    unblockHandler();
    assert.equal((await originalResponse).status, 200);
    const completed = await getDb().query<{ state: string }>(
      'SELECT state FROM wxpusher_callback_claims WHERE replay_key = $1',
      [originalReplayKey],
    );
    assert.deepEqual(completed.rows[0], { state: 'completed' });
    assert.equal((await callbackRequest(port, originalBody)).status, 409);
    assert.equal(sideEffects, 1);
  } finally {
    unblockHandler();
    await channel.stop();
  }
});

test('production handler rethrows RouteResult failure and prevents duplicate effects', async () => {
  const port = await reservePort();
  const body = validBody({ content: `#approve-phase ${randomUUID()}` });
  let effectCalls = 0;
  let routedPrincipal: unknown;
  const handlerErrors: Array<Record<string, unknown> | undefined> = [];
  const router = new MessageRouter({
    handlers: [{
      name: 'effect-then-fail',
      priority: 0,
      match: () => true,
      handle: async (context) => {
        effectCalls += 1;
        routedPrincipal = context.principal;
        return { handled: false, error: 'after_effect_failure' };
      },
    }],
  });
  const channel = createWeixinChannel(baseConfig(port));
  channel.onMessage(createWxPusherInboundHandler(router, {
    error: (_message, meta) => { handlerErrors.push(meta); },
  }));

  await channel.start();
  try {
    assert.equal((await callbackRequest(port, body)).status, 503);
    assert.equal((await callbackRequest(port, body)).status, 409);
    assert.equal(effectCalls, 1);
  } finally {
    await channel.stop();
  }

  assert.deepEqual(routedPrincipal, {
    kind: 'operator',
    subject: `wxpusher:${APP_ID}:${OPERATOR_UID}`,
    authenticatedBy: 'trusted_channel',
    capabilities: ['operator:*'],
    userId: OPERATOR_UID,
  });
  assert.deepEqual(handlerErrors, [{ errorClass: 'Error' }]);
  const failed = await getDb().query<{ state: string; failure_code: string | null }>(
    `SELECT state, failure_code FROM wxpusher_callback_claims
     WHERE failure_code = 'handler_failed' ORDER BY updated_at DESC LIMIT 1`,
  );
  assert.deepEqual(failed.rows[0], { state: 'failed', failure_code: 'handler_failed' });
});

test('handler side effect followed by throw is not re-executed on replay', async () => {
  const port = await reservePort();
  const body = validBody({ content: `#status ${randomUUID()}` });
  let sideEffects = 0;
  const channel = createWeixinChannel(baseConfig(port));
  channel.onMessage(async () => {
    sideEffects += 1;
    throw new Error('crash after side effect');
  });

  await channel.start();
  try {
    assert.equal((await callbackRequest(port, body)).status, 503);
    assert.equal((await callbackRequest(port, body)).status, 409);
    assert.equal(sideEffects, 1);
  } finally {
    await channel.stop();
  }
});

test('matching tags, source, appId, and uid cannot forge an authenticated ingress message', async () => {
  let routeCalls = 0;
  const forged = forgedMessage();
  await assert.rejects(
    routeTrustedWxPusherMessage(async () => {
      routeCalls += 1;
      return successfulRouteResult();
    }, forged),
    /authentication is missing or inconsistent/,
  );
  assert.equal(routeCalls, 0);
});

function baseConfig(port: number, overrides: Partial<WeixinChannelConfig> = {}): WeixinChannelConfig {
  return {
    kind: 'weixin',
    uids: [],
    callbackPort: port,
    callbackHost: HOST,
    upCallEnabled: true,
    expectedAppId: APP_ID,
    operatorUids: [OPERATOR_UID],
    callbackProxySecret: PROXY_SECRET,
    callbackToken: CALLBACK_TOKEN,
    callbackMaxAgeMs: 60_000,
    callbackMaxFutureSkewMs: 5_000,
    callbackMaxBodyBytes: 1_024,
    losGatewayUrl: 'http://127.0.0.1:8080',
    ...overrides,
  };
}

function validBody(overrides: Partial<{ uid: string; appId: number; time: number; content: string }> = {}) {
  return {
    action: 'send_up_cmd',
    data: {
      uid: overrides.uid ?? OPERATOR_UID,
      appId: overrides.appId ?? APP_ID,
      appName: 'los',
      time: overrides.time ?? Date.now(),
      content: overrides.content ?? `#status ${randomUUID()}`,
    },
  };
}

async function callbackRequest(
  port: number,
  body: unknown,
  options: { secret?: string; token?: string | null } = {},
): Promise<Response> {
  const token = options.token === undefined ? CALLBACK_TOKEN : options.token;
  const query = token === null ? '' : `?token=${encodeURIComponent(token)}`;
  return fetch(`http://${HOST}:${port}/wxpusher-callback${query}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-los-wxpusher-proxy-secret': options.secret ?? PROXY_SECRET,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function successfulRouteResult(): RouteResult {
  return {
    handled: true,
    intent: { type: 'status', sessionId: 'session-123' },
    text: 'ok',
  };
}

function forgedMessage(): UnifiedMessage {
  const now = new Date().toISOString();
  return {
    id: 'forged',
    type: 'COMMAND',
    version: '1.0',
    text: '#approve-phase forged',
    routing: { priority: 'NORMAL', recipient: OPERATOR_UID, replyTo: null, channel: 'weixin' },
    metadata: {
      timestamp: now,
      source: 'wxpusher-callback',
      channel: 'weixin',
      userId: OPERATOR_UID,
      appId: APP_ID,
      tags: ['up-call', 'trusted-channel'],
    },
    _internal: { standardizedAt: now, compressed: false, size: 20 },
  };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
