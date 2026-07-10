import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { TelegramActionRegistry } from './action-registry.js';
import { deleteTelegramActionEntries } from './telegram-action-store.js';

test('action registry keeps targets opaque and makes sibling decisions mutually exclusive', async () => {
  const sessionId = randomUUID();
  const callId = randomUUID();
  let sequence = 0;
  const registry = new TelegramActionRegistry(60_000, () => `opaque-${++sequence}`);
  const buttons = await registry.createButtons(sessionId, callId);
  const callbackData = buttons.flat().map(button => button.callback_data);

  try {
    assert.equal(callbackData.length, 3);
    for (const data of callbackData) {
      assert.ok(Buffer.byteLength(data, 'utf8') <= 64);
      assert.doesNotMatch(data, new RegExp(sessionId));
      assert.doesNotMatch(data, new RegExp(callId));
    }
    const approve = await registry.claim(callbackData[0]!, 'claim-approve');
    const deny = await registry.claim(callbackData[1]!, 'claim-deny');
    const escalate = await registry.claim(callbackData[2]!, 'claim-escalate');
    assert.equal(approve.status, 'claimed');
    if (approve.status === 'claimed') {
      assert.deepEqual(approve.target, { action: 'approve', sessionId, callId });
      assert.match(approve.decisionGroupId, /^tgd:/);
    }
    assert.deepEqual(deny, { status: 'processing' });
    assert.deepEqual(escalate, { status: 'processing' });
    await registry.consume(callbackData[0]!, 'claim-approve', 'callback-approve', 42);
    assert.deepEqual(await registry.claim(callbackData[1]!, 'claim-after-consume'), { status: 'consumed' });
  } finally {
    await deleteTelegramActionEntries(callbackData);
  }
});

test('action registry rejects oversized, unknown, and expired callback data', async () => {
  let now = 100;
  let sequence = 0;
  const registry = new TelegramActionRegistry(10, () => `short-token-${++sequence}`, () => now);
  const buttons = await registry.createButtons('session-a', 'call-a');
  const callbackData = buttons.flat().map(button => button.callback_data);
  try {
    assert.deepEqual(await registry.claim(`tg:${'x'.repeat(65)}`, 'oversized'), { status: 'invalid' });
    assert.deepEqual(await registry.claim('tg:unknown', 'unknown'), { status: 'invalid' });
    now = 111;
    assert.deepEqual(await registry.claim(callbackData[0]!, 'expired'), { status: 'invalid' });
  } finally {
    await deleteTelegramActionEntries(callbackData);
  }
});

test('persisted action survives registry restart and records one-time consume', async () => {
  let sequence = 0;
  const beforeRestart = new TelegramActionRegistry(60_000, () => `restart-${++sequence}`);
  const decisionGroupId = 'tgd:restart-test';
  const buttons = await beforeRestart.createButtons('session-restart', 'call-restart', decisionGroupId);
  const callbackData = buttons.flat().map(button => button.callback_data);
  const token = callbackData[0]!;
  try {
    const afterRestart = new TelegramActionRegistry();
    assert.deepEqual(await afterRestart.claim(token, 'callback-restart'), {
      status: 'claimed',
      decisionGroupId,
      target: { action: 'approve', sessionId: 'session-restart', callId: 'call-restart' },
    });
    await afterRestart.consume(token, 'callback-restart', 'callback-restart', 42);
    assert.deepEqual(await new TelegramActionRegistry().claim(token, 'callback-replay'), { status: 'consumed' });
  } finally {
    await deleteTelegramActionEntries(callbackData);
  }
});

test('expired processing lease is reclaimed after a simulated process crash', async () => {
  let now = Date.now();
  let sequence = 0;
  const firstProcess = new TelegramActionRegistry(60_000, () => `lease-${++sequence}`, () => now, 10);
  const decisionGroupId = 'tgd:lease-test';
  const buttons = await firstProcess.createButtons('session-lease', 'call-lease', decisionGroupId);
  const tokens = buttons.flat().map(button => button.callback_data);
  const token = tokens[0]!;
  try {
    assert.equal((await firstProcess.claim(token, 'crashed-callback')).status, 'claimed');

    now += 5;
    const beforeLeaseExpiry = new TelegramActionRegistry(60_000, undefined, () => now, 10);
    assert.deepEqual(await beforeLeaseExpiry.claim(token, 'early-retry'), { status: 'processing' });

    now += 6;
    const recoveredProcess = new TelegramActionRegistry(60_000, undefined, () => now, 10);
    const recovered = await recoveredProcess.claim(tokens[1]!, 'recovered-callback');
    assert.deepEqual(recovered, {
      status: 'claimed',
      decisionGroupId,
      target: { action: 'deny', sessionId: 'session-lease', callId: 'call-lease' },
    });
    await recoveredProcess.consume(tokens[1]!, 'recovered-callback', 'recovered-callback', 42);
    assert.deepEqual(await new TelegramActionRegistry().claim(token, 'old-action-replay'), { status: 'consumed' });
  } finally {
    await deleteTelegramActionEntries(tokens);
  }
});

test('buttons sent to different chats share one decision group across restart', async () => {
  let sequence = 0;
  const registry = new TelegramActionRegistry(60_000, () => `multi-chat-${++sequence}`);
  const decisionGroupId = registry.createDecisionGroupId();
  const chatOne = await registry.createButtons('session-multi', 'call-multi', decisionGroupId);
  const chatTwo = await registry.createButtons('session-multi', 'call-multi', decisionGroupId);
  const tokens = [...chatOne.flat(), ...chatTwo.flat()].map(button => button.callback_data);

  try {
    const [approve, deny] = await Promise.all([
      registry.claim(chatOne[0]![0]!.callback_data, 'callback-chat-one'),
      registry.claim(chatTwo[0]![1]!.callback_data, 'callback-chat-two'),
    ]);
    assert.equal([approve.status, deny.status].filter(status => status === 'claimed').length, 1);
    assert.equal([approve.status, deny.status].filter(status => status === 'processing').length, 1);

    const winner = approve.status === 'claimed'
      ? { token: chatOne[0]![0]!.callback_data, claimId: 'callback-chat-one' }
      : { token: chatTwo[0]![1]!.callback_data, claimId: 'callback-chat-two' };
    await registry.consume(winner.token, winner.claimId, winner.claimId, 42);

    const restarted = new TelegramActionRegistry();
    for (const token of tokens) {
      assert.deepEqual(await restarted.claim(token, `restart-${token}`), { status: 'consumed' });
    }
  } finally {
    await deleteTelegramActionEntries(tokens);
  }
});
