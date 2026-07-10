import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { TelegramActionRegistry } from './action-registry.js';
import { createOperatorActionHandler } from './operator-actions.js';
import { createTelegramUpdateProcessor } from './telegram-updates.js';
import { createTelegramWebhookHandler, startTelegramWebhook } from './telegram-webhook.js';
import { deleteTelegramActionEntries } from './telegram-action-store.js';

const SECRET = 'telegram_webhook_secret_1234567890';

test('webhook startup keeps the server listening after Telegram accepts registration', async () => {
  const server = createServer((_request, response) => response.end('ok'));
  let registrationBody: Record<string, unknown> | undefined;

  try {
    await startTelegramWebhook({
      server,
      port: 0,
      host: '127.0.0.1',
      webhookUrl: 'https://bot.example.com',
      secret: SECRET,
      setWebhook: async body => {
        registrationBody = body;
        return { ok: true, result: true };
      },
    });

    assert.equal(server.listening, true);
    assert.deepEqual(registrationBody, {
      url: 'https://bot.example.com/telegram-webhook',
      secret_token: SECRET,
      allowed_updates: ['message', 'callback_query'],
    });
  } finally {
    await closeServer(server);
  }
});

test('webhook startup closes the server when Telegram rejects registration', async () => {
  const server = createServer((_request, response) => response.end('ok'));

  await assert.rejects(startTelegramWebhook({
    server,
    port: 0,
    host: '127.0.0.1',
    webhookUrl: 'https://bot.example.com',
    secret: SECRET,
    setWebhook: async () => ({ ok: false, result: false, description: 'invalid webhook' }),
  }), /Telegram webhook startup failed: Telegram setWebhook rejected: invalid webhook/);
  assert.equal(server.listening, false);
});

test('webhook startup closes the server when Telegram registration throws', async () => {
  const server = createServer((_request, response) => response.end('ok'));

  await assert.rejects(startTelegramWebhook({
    server,
    port: 0,
    host: '127.0.0.1',
    webhookUrl: 'https://bot.example.com',
    secret: SECRET,
    setWebhook: async () => { throw new Error('network unavailable'); },
  }), /Telegram webhook startup failed: network unavailable/);
  assert.equal(server.listening, false);
});

test('real webhook handler rejects missing and incorrect secrets', async () => {
  let processed = 0;
  await withWebhook(async baseUrl => {
    const missing = await postUpdate(baseUrl, undefined, updateBody(1));
    const incorrect = await postUpdate(baseUrl, `${SECRET}x`, updateBody(2));
    assert.equal(missing.status, 401);
    assert.equal(incorrect.status, 401);
    assert.equal(processed, 0);
  }, async () => { processed += 1; });
});

test('real webhook handler collapses concurrent callback replays', async () => {
  let callbacks = 0;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const processUpdate = createTelegramUpdateProcessor({
    handleCallback: async () => {
      callbacks += 1;
      await blocked;
    },
  });

  await withWebhook(async baseUrl => {
    const body = updateBody(3);
    const first = postUpdate(baseUrl, SECRET, body);
    const replay = postUpdate(baseUrl, SECRET, body);
    await waitFor(() => callbacks === 1);
    release();
    const responses = await Promise.all([first, replay]);
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    assert.equal(callbacks, 1);
  }, processUpdate);
});

test('real webhook handler rejects an unauthorized member of an allowed group', async () => {
  let gatewayCalls = 0;
  const answers: string[] = [];
  const registry = new TelegramActionRegistry();
  const buttons = await registry.createButtons('session-a', 'call-a');
  const tokens = buttons.flat().map(button => button.callback_data);
  const callbackData = tokens[0]!;
  const handleCallback = createOperatorActionHandler({
    gatewayUrl: 'http://127.0.0.1:8080',
    allowedChatIds: new Set([-100]),
    allowedUserIds: new Set([42]),
    actionRegistry: registry,
    makeHeaders: extra => extra ?? {},
    answerCallback: async (_id, text) => { answers.push(text ?? ''); },
    fetchImpl: async () => {
      gatewayCalls += 1;
      return { ok: true, status: 200 } as Response;
    },
    warn: () => undefined,
  });
  const processUpdate = createTelegramUpdateProcessor({ handleCallback });

  try {
    await withWebhook(async baseUrl => {
      const response = await postUpdate(baseUrl, SECRET, {
        update_id: 4,
        callback_query: {
          id: 'callback-group-member',
          from: { id: 99 },
          message: { message_id: 1, chat: { id: -100 } },
          data: callbackData,
        },
      });
      assert.equal(response.status, 200);
      assert.equal(gatewayCalls, 0);
      assert.deepEqual(answers, ['Unauthorized operator']);
    }, processUpdate);
  } finally {
    await deleteTelegramActionEntries(tokens);
  }
});

async function withWebhook(
  run: (baseUrl: string) => Promise<void>,
  processUpdate: Parameters<typeof createTelegramWebhookHandler>[0]['processUpdate'],
): Promise<void> {
  const server = createServer(createTelegramWebhookHandler({ secret: SECRET, processUpdate }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Webhook test server did not bind');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await closeServer(server);
  }
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function postUpdate(baseUrl: string, secret: string | undefined, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/telegram-webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}),
    },
    body: JSON.stringify(body),
  });
}

function updateBody(updateId: number) {
  return {
    update_id: updateId,
    callback_query: {
      id: 'callback-real-handler',
      from: { id: 42 },
      message: { message_id: 1, chat: { id: -100 } },
      data: 'tg:opaque',
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for webhook processing');
}
