import assert from 'node:assert/strict';
import test from 'node:test';

import { createWebChannel } from './web.js';

test('web channel exposes WeChat process and SSE readiness', async () => {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  let connected = false;
  let externalReady = false;
  const channel = createWebChannel({
    kind: 'web',
    host: '127.0.0.1',
    port,
    losGatewayUrl: 'http://127.0.0.1:8080',
    healthSnapshot: () => ({
      ready: connected && externalReady,
      sseConnected: connected,
      externalReady,
      weclawAvailable: false,
      wxpusherConfigured: externalReady,
    }),
  });

  await channel.start();
  try {
    const starting = await fetch(`http://127.0.0.1:${port}/health`).then(response => response.json());
    assert.equal(starting.status, 'ok');
    assert.equal(starting.service, 'wechat-bot');
    assert.equal(starting.ready, false);
    assert.equal(starting.sseConnected, false);
    assert.equal(starting.externalReady, false);

    connected = true;
    externalReady = true;
    const ready = await fetch(`http://127.0.0.1:${port}/health`).then(response => response.json());
    assert.equal(ready.ready, true);
    assert.equal(ready.sseConnected, true);
    assert.equal(ready.externalReady, true);
  } finally {
    await channel.stop();
  }
});
