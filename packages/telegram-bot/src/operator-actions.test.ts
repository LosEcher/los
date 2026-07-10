import assert from 'node:assert/strict';
import test from 'node:test';
import { TelegramActionRegistry } from './action-registry.js';
import { createOperatorActionHandler } from './operator-actions.js';
import { deleteTelegramActionEntries } from './telegram-action-store.js';

test('callback handler rejects an unauthorized group member in an allowed chat', async () => {
  let fetchCalls = 0;
  const answers: Array<[string, string | undefined]> = [];
  const warnings: string[] = [];
  const handleCallback = createOperatorActionHandler({
    gatewayUrl: 'http://127.0.0.1:8080',
    allowedChatIds: new Set([123]),
    allowedUserIds: new Set([42]),
    actionRegistry: new TelegramActionRegistry(),
    makeHeaders: () => ({ 'x-los-operator-token': 'operator-token' }),
    answerCallback: async (id, text) => { answers.push([id, text]); },
    fetchImpl: async () => {
      fetchCalls += 1;
      return { ok: true, status: 200 } as Response;
    },
    warn: message => { warnings.push(message); },
  });

  await handleCallback({
    id: 'callback-unauthorized',
    from: { id: 999 },
    message: { message_id: 1, chat: { id: 123 } },
    data: 'tg:forged',
  });

  assert.equal(fetchCalls, 0);
  assert.deepEqual(answers, [['callback-unauthorized', 'Unauthorized operator']]);
  assert.match(warnings[0] ?? '', /999/);
});

test('authorized callback posts steering through the gateway operator-token boundary', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const answers: Array<[string, string | undefined]> = [];
  const registry = new TelegramActionRegistry();
  const decisionGroupId = 'tgd:authorized-test';
  const buttons = await registry.createButtons('session-a', 'call-a', decisionGroupId);
  const tokens = buttons.flat().map(button => button.callback_data);
  const callbackData = tokens[0]!;
  const handleCallback = createOperatorActionHandler({
    gatewayUrl: 'http://127.0.0.1:8080',
    allowedChatIds: new Set([123]),
    allowedUserIds: new Set([42]),
    actionRegistry: registry,
    makeHeaders: extra => ({ ...extra, 'x-los-operator-token': 'operator-token' }),
    answerCallback: async (id, text) => { answers.push([id, text]); },
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      return { ok: true, status: 200 } as Response;
    },
  });

  try {
    await handleCallback({
      id: 'callback-authorized',
      from: { id: 42 },
      message: { message_id: 2, chat: { id: 123 } },
      data: callbackData,
    });
    await handleCallback({
      id: 'callback-second-click',
      from: { id: 42 },
      message: { message_id: 2, chat: { id: 123 } },
      data: callbackData,
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, 'http://127.0.0.1:8080/sessions/session-a/operator-events');
    assert.equal((requests[0]?.init.headers as Record<string, string>)['x-los-operator-token'], 'operator-token');
    assert.equal(
      (requests[0]?.init.headers as Record<string, string>)['x-idempotency-key'],
      `telegram-decision:${decisionGroupId}`,
    );
    assert.equal((requests[0]?.init.headers as Record<string, string>)['x-user-id'], 'telegram:42');
    assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
      type: 'steering',
      instruction: 'Approved via Telegram: callId=call-a',
      turnBoundary: 'immediate',
      reason: 'operator_approval',
    });
    assert.deepEqual(answers, [
      ['callback-authorized', '✅ Approved'],
      ['callback-second-click', 'Action already handled'],
    ]);
  } finally {
    await deleteTelegramActionEntries(tokens);
  }
});

test('opposite decisions from different allowed chats execute once', async () => {
  let fetchCalls = 0;
  let releaseFetch!: () => void;
  const blockedFetch = new Promise<void>(resolve => { releaseFetch = resolve; });
  const answers: string[] = [];
  const registry = new TelegramActionRegistry();
  const decisionGroupId = registry.createDecisionGroupId();
  const firstChatButtons = await registry.createButtons('session-concurrent', 'call-concurrent', decisionGroupId);
  const secondChatButtons = await registry.createButtons('session-concurrent', 'call-concurrent', decisionGroupId);
  const tokens = [...firstChatButtons.flat(), ...secondChatButtons.flat()].map(button => button.callback_data);
  const approveData = firstChatButtons[0]![0]!.callback_data;
  const denyData = secondChatButtons[0]![1]!.callback_data;
  const handleCallback = createOperatorActionHandler({
    gatewayUrl: 'http://127.0.0.1:8080',
    allowedChatIds: new Set([123, 456]),
    allowedUserIds: new Set([42]),
    actionRegistry: registry,
    makeHeaders: extra => extra ?? {},
    answerCallback: async (_id, text) => { answers.push(text ?? ''); },
    fetchImpl: async () => {
      fetchCalls += 1;
      await blockedFetch;
      return { ok: true, status: 200 } as Response;
    },
  });

  try {
    const first = handleCallback(callback('concurrent-approve', approveData, 123));
    await waitFor(() => fetchCalls === 1);
    const second = handleCallback(callback('concurrent-deny', denyData, 456));
    await second;
    releaseFetch();
    await first;

    assert.equal(fetchCalls, 1);
    assert.deepEqual(answers.sort(), ['Action already processing', '✅ Approved'].sort());
  } finally {
    await deleteTelegramActionEntries(tokens);
  }
});

test('consume crash retries an opposite decision with the same gateway idempotency key', async () => {
  class CrashBeforeConsumeRegistry extends TelegramActionRegistry {
    override async consume(): Promise<void> {
      throw new Error('simulated crash before consume');
    }
  }

  const requests: Array<{ key: string; body: string }> = [];
  const acceptedBodies: string[] = [];
  const answers: string[] = [];
  const registry = new CrashBeforeConsumeRegistry();
  const decisionGroupId = registry.createDecisionGroupId();
  const firstChatButtons = await registry.createButtons('session-crash', 'call-crash', decisionGroupId);
  const secondChatButtons = await registry.createButtons('session-crash', 'call-crash', decisionGroupId);
  const tokens = [...firstChatButtons.flat(), ...secondChatButtons.flat()].map(button => button.callback_data);
  const handleCallback = createOperatorActionHandler({
    gatewayUrl: 'http://127.0.0.1:8080',
    allowedChatIds: new Set([123, 456]),
    allowedUserIds: new Set([42]),
    actionRegistry: registry,
    makeHeaders: extra => extra ?? {},
    answerCallback: async (_id, text) => { answers.push(text ?? ''); },
    fetchImpl: async (_input, init) => {
      const headers = init?.headers as Record<string, string>;
      const request = { key: headers['x-idempotency-key']!, body: String(init?.body) };
      requests.push(request);
      if (requests.length === 1) {
        acceptedBodies.push(request.body);
        return { ok: true, status: 200 } as Response;
      }
      const replayMatches = request.key === requests[0]!.key && request.body === requests[0]!.body;
      return { ok: replayMatches, status: replayMatches ? 200 : 409 } as Response;
    },
  });

  try {
    await assert.rejects(
      handleCallback(callback('crash-approve', firstChatButtons[0]![0]!.callback_data, 123)),
      /simulated crash before consume/,
    );
    await handleCallback(callback('retry-deny', secondChatButtons[0]![1]!.callback_data, 456));

    assert.equal(requests.length, 2);
    assert.equal(new Set(requests.map(request => request.key)).size, 1);
    assert.equal(requests[0]!.key, `telegram-decision:${decisionGroupId}`);
    assert.notEqual(requests[0]!.body, requests[1]!.body);
    assert.equal(acceptedBodies.length, 1);
    assert.deepEqual(answers, ['Telegram action failed: 409']);
  } finally {
    await deleteTelegramActionEntries(tokens);
  }
});

function callback(id: string, data: string, chatId = 123) {
  return {
    id,
    from: { id: 42 },
    message: { message_id: 2, chat: { id: chatId } },
    data,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for concurrent Telegram action');
}
