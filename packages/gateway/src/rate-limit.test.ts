import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import { createRateLimiter } from './rate-limit.js';

test('rate limiter interval can be cleared on server close', async () => {
  const app = Fastify({ logger: false });
  const limiter = createRateLimiter({ max: 1, windowMs: 60_000 });
  app.addHook('onClose', async () => clearInterval(limiter.cleanupInterval));
  app.get('/', { preHandler: limiter.hook }, async () => ({ ok: true }));

  assert.equal(limiter.cleanupInterval.hasRef(), false);
  const originalClearInterval = globalThis.clearInterval;
  let clearedLimiterInterval = false;
  globalThis.clearInterval = ((timer: Parameters<typeof clearInterval>[0]) => {
    if (timer === limiter.cleanupInterval) clearedLimiterInterval = true;
    return originalClearInterval(timer);
  }) as typeof clearInterval;

  try {
    await app.close();
    assert.equal(clearedLimiterInterval, true);
  } finally {
    globalThis.clearInterval = originalClearInterval;
  }
});
