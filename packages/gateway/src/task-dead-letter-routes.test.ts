import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { loadConfig, setConfig } from '@los/infra/config';
import { registerRequestContext } from './request-context.js';
import { registerTaskRoutes } from './routes/orchestration/task-routes.js';
import type { TaskRouteDependencies } from './routes/orchestration/task-routes.js';

// ── Stub deps: in-memory dead letter store, no DB ──

const deadLetterStore = new Map<string, Record<string, unknown>>();
let nextEventId = 1;

const stubDeps: TaskRouteDependencies = {
  ensureTaskRunStore: async () => ({} as any),
  acknowledgeDeadLetterEvent: async (id: string, input: any) => {
    const event = deadLetterStore.get(id);
    if (!event) return null;
    // accepted_loss requires a note
    if (input.resolution === 'accepted_loss' && (!input.note || !(input.note as string).trim())) {
      const err: any = new Error('dead_letter_resolution_note_required');
      err.code = 'dead_letter_resolution_note_required';
      throw err;
    }
    event.resolution = input.resolution;
    event.resolvedBy = input.actor;
    event.resolvedAt = new Date().toISOString();
    event.note = input.note ?? null;
    return event as any;
  },
  appendSessionEvent: async (_input: any) => ({ id: 1 }) as any,
  cancelScheduledTask: (_id: string, _reason?: string) => false,
  listDeadLetterEvents: async (_opts?: any) => Array.from(deadLetterStore.values()) as any,
  listServiceInstances: async (_limit?: number) => [] as any,
  listTaskRuns: async (_limit?: number) => [] as any,
  listTaskRunsByStatus: async (_status: string, _limit?: number) => [] as any,
  loadTaskRun: async (_id: string) => null as any,
  requestCancellation: async (_id: string, _reason: string, _source: string) => {},
  requeueDeadLetterEvent: async (id: string) => {
    const event = deadLetterStore.get(id);
    if (!event) return { status: 'not_found', reason: 'not found' } as any;
    const reason = (event as any).reason as string;
    if (reason !== 'recoverable_error') return { status: 'reason_not_retryable', reason: 'not retryable', event } as any;
    return { status: 'requeued', event } as any;
  },
  summarizeDeadLetterEvents: async () => ({
    total: deadLetterStore.size,
    byReason: { unrecoverable_error: { total: deadLetterStore.size } },
    byResolution: {},
    recentEvent: null,
  }) as any,
  transitionExecutionState: async (_input: any) => ({} as any),
  updateTaskRunFields: async (_id: string, _fields: any) => ({} as any),
};

// Helper: create a fake dead letter event in the stub store
function seedDeadLetter(id: string, overrides: Record<string, unknown> = {}) {
  const event = {
    id,
    reason: 'unrecoverable_error',
    originalError: 'test-only failure',
    eventPayload: { routeTest: true },
    acknowledged: false,
    resolution: null,
    resolvedBy: null,
    resolvedAt: null,
    note: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  deadLetterStore.set(id, event);
  return event;
}

test('dead-letter routes require an audited operator resolution and gate retry', async () => {
  const originalConfig = await loadConfig();
  const config = structuredClone(originalConfig);
  config.auth.enabled = true;
  config.auth.operatorToken = 'dlq-operator-token';
  setConfig(config);
  const app = Fastify({ logger: false });
  registerRequestContext(app, config);
  registerTaskRoutes(app, stubDeps);

  const event = seedDeadLetter(`dlq-${nextEventId++}`);

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
    assert.equal(notRetryable.json().error, 'not retryable');

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
    await app.close();
    setConfig(originalConfig);
  }
});
