import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { getDb } from '@los/infra/db';
import { getConfig, setConfig } from '@los/infra/config';
import { writeDeadLetterEvent } from '@los/agent/dead-letter';
import { registerRequestContext } from './request-context.js';
import { registerTaskRoutes } from './routes/orchestration/task-routes.js';

test('dead-letter routes expose summary and gate retry as an operator action', async () => {
  const originalConfig = getConfig();
  const config = structuredClone(originalConfig);
  config.auth.enabled = true;
  config.auth.operatorToken = 'dlq-operator-token';
  setConfig(config);
  const app = Fastify({ logger: false });
  registerRequestContext(app, config);
  registerTaskRoutes(app);
  const event = await writeDeadLetterEvent({
    reason: 'unrecoverable_error',
    originalError: 'test-only failure',
    eventPayload: { routeTest: true },
  });

  try {
    const summary = await app.inject({ method: 'GET', url: '/tasks/dead-letter/summary' });
    assert.equal(summary.statusCode, 200);
    assert.equal(summary.json().byReason.unrecoverable_error.total >= 1, true);

    const forbidden = await app.inject({ method: 'POST', url: `/tasks/dead-letter/${event.id}/retry` });
    assert.equal(forbidden.statusCode, 403);

    const notRetryable = await app.inject({
      method: 'POST',
      url: `/tasks/dead-letter/${event.id}/retry`,
      headers: { 'x-los-operator-token': 'dlq-operator-token' },
    });
    assert.equal(notRetryable.statusCode, 409);
    assert.equal(notRetryable.json().error, 'reason_not_retryable');
  } finally {
    await getDb().query('DELETE FROM dead_letter_events WHERE id = $1', [event.id]).catch(() => undefined);
    await app.close();
    setConfig(originalConfig);
  }
});
