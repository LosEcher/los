import test from 'node:test';
import assert from 'node:assert/strict';
import { _resolveAuthRoute } from './auth.js';

test('auth routing accepts the documented provider-first order', () => {
  assert.deepEqual(_resolveAuthRoute(['xai', 'login']), { provider: 'xai', subcommand: 'login' });
  assert.deepEqual(_resolveAuthRoute(['xai', 'status']), { provider: 'xai', subcommand: 'status' });
  assert.deepEqual(_resolveAuthRoute(['xai', 'logout']), { provider: 'xai', subcommand: 'logout' });
});

test('auth routing keeps the historical subcommand-first order compatible', () => {
  assert.deepEqual(_resolveAuthRoute(['status', 'xai']), { provider: 'xai', subcommand: 'status' });
  assert.deepEqual(_resolveAuthRoute(['login']), { provider: 'xai', subcommand: 'login' });
});
