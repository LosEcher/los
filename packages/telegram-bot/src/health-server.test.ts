import assert from 'node:assert/strict';
import test from 'node:test';

import { startTelegramHealthServer } from './health-server.js';

test('telegram health server exposes process and SSE readiness separately', async () => {
  let connected = false;
  const server = await startTelegramHealthServer({
    port: 0,
    getSnapshot: () => ({ ready: connected, sseConnected: connected, telegramConnected: connected, mode: 'polling' }),
  });

  try {
    const starting = await fetch(`${server.url}/health`).then(response => response.json());
    assert.equal(starting.status, 'ok');
    assert.equal(starting.service, 'telegram-bot');
    assert.equal(typeof starting.uptimeSeconds, 'number');
    assert.ok(starting.uptimeSeconds >= 0);
    assert.equal(starting.ready, false);
    assert.equal(starting.sseConnected, false);
    assert.equal(starting.telegramConnected, false);
    assert.equal(starting.mode, 'polling');

    connected = true;
    const ready = await fetch(`${server.url}/health`).then(response => response.json());
    assert.equal(ready.ready, true);
    assert.equal(ready.sseConnected, true);
    assert.equal(ready.telegramConnected, true);
  } finally {
    await server.close();
  }
});
