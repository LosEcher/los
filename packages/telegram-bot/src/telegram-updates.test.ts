import assert from 'node:assert/strict';
import test from 'node:test';
import type { TelegramUpdate } from './operator-actions.js';
import { createTelegramUpdateProcessor, prepareTelegramPolling, runTelegramPollingLoop } from './telegram-updates.js';

test('update processor executes concurrent update/callback replays once', async () => {
  let callbacks = 0;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const processUpdate = createTelegramUpdateProcessor({
    handleCallback: async () => {
      callbacks += 1;
      await blocked;
    },
  });
  const update = callbackUpdate(100, 'callback-a');

  const first = processUpdate(update);
  const replay = processUpdate({ ...update });
  const callbackReplay = processUpdate(callbackUpdate(101, 'callback-a'));
  release();

  assert.deepEqual(await Promise.all([first, replay, callbackReplay]), [true, false, false]);
  assert.equal(callbacks, 1);
});

test('polling loop awaits each request and update without overlap', async () => {
  const controller = new AbortController();
  let activeRequests = 0;
  let maxActiveRequests = 0;
  let requestCount = 0;
  const processed: number[] = [];

  await runTelegramPollingLoop({
    signal: controller.signal,
    intervalMs: 0,
    wait: async () => undefined,
    getUpdates: async () => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      requestCount += 1;
      await Promise.resolve();
      activeRequests -= 1;
      if (requestCount === 2) controller.abort();
      return requestCount === 1 ? [callbackUpdate(200, 'callback-b')] : [];
    },
    processUpdate: async update => { processed.push(update.update_id!); },
  });

  assert.equal(maxActiveRequests, 1);
  assert.deepEqual(processed, [200]);
});

test('polling preparation deletes the webhook without dropping pending updates', async () => {
  const calls: Array<{ drop_pending_updates: false }> = [];
  await prepareTelegramPolling(async options => {
    calls.push(options);
    return { ok: true, result: true };
  });
  assert.deepEqual(calls, [{ drop_pending_updates: false }]);
  await assert.rejects(
    prepareTelegramPolling(async () => ({ ok: false, result: false })),
    /deleteWebhook failed/,
  );
});

function callbackUpdate(updateId: number, callbackId: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: callbackId,
      from: { id: 42 },
      message: { message_id: 1, chat: { id: -100 } },
      data: 'tg:opaque',
    },
  };
}
