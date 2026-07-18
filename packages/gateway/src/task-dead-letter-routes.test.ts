import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { getDb } from '@los/infra/db';
import { getConfig, setConfig } from '@los/infra/config';
import { writeDeadLetterEvent } from '@los/agent/dead-letter';
import { registerRequestContext } from './request-context.js';
import { registerTaskRoutes } from './routes/orchestration/task-routes.js';

test('dead-letter routes require an audited operator resolution and gate retry', async () => {
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

    const forbiddenAck = await app.inject({
      method: 'POST', url: `/tasks/dead-letter/${event.id}/ack`,
      payload: { resolution: 'superseded' },
    });
    assert.equal(forbiddenAck.statusCode, 403);

    const missingNote = await app.inject({
      method: 'POST', url: `/tasks/dead-letter/${event.id}/ack`,
      headers: { 'x-los-operator-token': 'dlq-operator-token' },
      payload: { resolution: 'accepted_loss' },
    });
    assert.equal(missingNote.statusCode, 400);
    assert.equal(missingNote.json().error, 'dead_letter_resolution_note_required');

    const notRetryable = await app.inject({
      method: 'POST',
      url: `/tasks/dead-letter/${event.id}/retry`,
      headers: { 'x-los-operator-token': 'dlq-operator-token' },
    });
    assert.equal(notRetryable.statusCode, 409);
    assert.equal(notRetryable.json().error, 'reason_not_retryable');

    const acknowledged = await app.inject({
      method: 'POST', url: `/tasks/dead-letter/${event.id}/ack`,
      headers: { 'x-los-operator-token': 'dlq-operator-token' },
      payload: { resolution: 'regression_covered', note: 'covered by malformed-output fixture' },
    });
    assert.equal(acknowledged.statusCode, 200);
    assert.equal(acknowledged.json().resolution, 'regression_covered');
    assert.equal(acknowledged.json().resolvedBy, 'operator:shared-token');
    assert.ok(acknowledged.json().resolvedAt);
  } finally {
    await getDb().query('DELETE FROM dead_letter_events WHERE id = $1', [event.id]).catch(() => undefined);
    await app.close();
    setConfig(originalConfig);
  }
});
