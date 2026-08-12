import assert from 'node:assert/strict';
import test from 'node:test';
import { assessWeixinDelivery } from './communication-delivery.js';

test('account file alone is unbound without token', () => {
  const a = assessWeixinDelivery({
    accountCount: 1,
    hasTokenAccount: false,
    daemonRunning: true,
    defaultToConfigured: true,
    bot: null,
  });
  assert.equal(a.status, 'unbound');
  assert.equal(a.layers.credentials, 'failed');
});

test('credentials + daemon without bot is bot_unreachable not connected', () => {
  const a = assessWeixinDelivery({
    accountCount: 1,
    hasTokenAccount: true,
    daemonRunning: true,
    defaultToConfigured: true,
    bot: null,
  });
  assert.equal(a.status, 'bot_unreachable');
  assert.equal(a.credentialBound, true);
  assert.equal(a.statusTone, 'warn');
});

test('send unhealthy is send_degraded even if daemon /health is ok', () => {
  const a = assessWeixinDelivery({
    accountCount: 1,
    hasTokenAccount: true,
    daemonRunning: true,
    defaultToConfigured: true,
    bot: {
      ready: false,
      sseConnected: true,
      weclawAvailable: true,
      weclawSendHealthy: false,
      weclawSendFailures: 2,
      weclawLastSendError: 'prepare failed',
      externalReady: false,
    },
  });
  assert.equal(a.status, 'send_degraded');
  assert.equal(a.layers.send, 'failed');
  assert.equal(a.weclawLastSendError, 'prepare failed');
  assert.equal(a.statusTone, 'err');
});

test('bot ready + send healthy is delivery_ready', () => {
  const a = assessWeixinDelivery({
    accountCount: 1,
    hasTokenAccount: true,
    daemonRunning: true,
    defaultToConfigured: true,
    bot: {
      ready: true,
      sseConnected: true,
      weclawAvailable: true,
      weclawSendHealthy: true,
      externalReady: true,
    },
  });
  assert.equal(a.status, 'delivery_ready');
  assert.equal(a.statusTone, 'ok');
});

test('daemon down with credentials is daemon_down', () => {
  const a = assessWeixinDelivery({
    accountCount: 1,
    hasTokenAccount: true,
    daemonRunning: false,
    defaultToConfigured: true,
    bot: null,
  });
  assert.equal(a.status, 'daemon_down');
});
