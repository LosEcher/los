import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import { resolveDirectRunCompletionDecision } from './chat-run-completion.js';
import { registerChatRoute } from './chat-route.js';

test('direct chat run completion blocks on unsatisfied required verification records', () => {
  const decision = resolveDirectRunCompletionDecision([
    { id: 'check-required', checkName: 'required', required: true, status: 'required' },
    { id: 'check-running', checkName: 'running', required: true, status: 'running' },
    { id: 'check-failed', checkName: 'failed', required: true, status: 'failed' },
    { id: 'check-optional-failed', checkName: 'optional', required: false, status: 'failed' },
  ]);

  assert.equal(decision.status, 'blocked');
  assert.deepEqual(decision.blockedVerificationRecordIds, [
    'check-required',
    'check-running',
    'check-failed',
  ]);
});

test('direct chat run completion succeeds only for allowlisted skipped verification', () => {
  const decision = resolveDirectRunCompletionDecision([
    { id: 'check-ok', checkName: 'pnpm check', required: true, status: 'succeeded' },
    { id: 'check-skipped', checkName: 'browser smoke', required: true, status: 'skipped' },
    { id: 'check-optional-failed', checkName: 'optional', required: false, status: 'failed' },
  ], ['browser smoke']);

  assert.equal(decision.status, 'succeeded');
  assert.deepEqual(decision.blockedVerificationRecordIds, []);
});

test('direct chat run completion blocks non-allowlisted skipped verification', () => {
  const decision = resolveDirectRunCompletionDecision([
    { id: 'check-skipped', checkName: 'browser smoke', required: true, status: 'skipped' },
  ]);
  assert.equal(decision.status, 'blocked');
});

test('chat route keeps a 1MB request body limit', async () => {
  const app = Fastify({ logger: false });
  registerChatRoute(app, {} as any, process.cwd());

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/chat',
      payload: { prompt: 'x'.repeat(1024 * 1024 + 128) },
    });

    assert.equal(response.statusCode, 413);
  } finally {
    await app.close();
  }
});
