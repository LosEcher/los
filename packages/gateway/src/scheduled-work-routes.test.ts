import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify from 'fastify';
import { getConfig, setConfig } from '@los/infra/config';

import { registerRequestContext } from './request-context.js';
import { registerScheduledWorkRoutes, type ScheduledWorkRouteDeps } from './routes/orchestration/scheduled-work-routes.js';

test('scheduled work routes preview, enforce operator writes, and expose history', async () => {
  const original = getConfig();
  const config = { ...original, auth: { enabled: true, token: 'access-token', operatorToken: 'operator-token' } };
  setConfig(config);
  const app = Fastify({ logger: false });
  registerRequestContext(app, config);
  const schedule = fixtureSchedule();
  let triggerCount = 0;
  let createdInput: Parameters<ScheduledWorkRouteDeps['create']>[0] | undefined;
  const deps: ScheduledWorkRouteDeps = {
    preview: () => ['2026-07-20T00:00:00.000Z', '2026-07-21T00:00:00.000Z'],
    create: async input => { createdInput = input; return schedule; },
    list: async () => [schedule],
    load: async id => id === schedule.id ? schedule : null,
    update: async (id, input) => id === schedule.id ? { ...schedule, status: input.status ?? schedule.status } : null,
    listRuns: async () => [{
      id: 'schedule-run-1', scheduleId: schedule.id, scheduledFor: '2026-07-20T00:00:00.000Z',
      triggerKind: 'manual', status: 'succeeded', attemptCount: 1, maxAttempts: 2,
      createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z',
    }],
    trigger: async () => {
      triggerCount += 1;
      return {
        id: 'schedule-run-2', scheduleId: schedule.id, scheduledFor: '2026-07-20T01:00:00.000Z',
        triggerKind: 'manual', status: 'succeeded', attemptCount: 1, maxAttempts: 2,
        createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z',
      };
    },
    retry: async () => { throw new Error('not used'); },
    execute: async () => 'succeeded',
  };
  registerScheduledWorkRoutes(app, deps);
  try {
    const preview = await app.inject({
      method: 'GET',
      url: '/scheduled-work-items/preview?kind=cron&expression=0%208%20*%20*%20*&timezone=Asia%2FShanghai',
      headers: { 'x-los-auth-token': 'access-token' },
    });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json().occurrences.length, 2);

    const denied = await app.inject({
      method: 'POST', url: '/scheduled-work-items',
      headers: { 'x-los-auth-token': 'access-token' }, payload: {},
    });
    assert.equal(denied.statusCode, 403);

    const created = await app.inject({
      method: 'POST', url: '/scheduled-work-items',
      headers: { 'x-los-operator-token': 'operator-token' },
      payload: { title: 'Morning digest', trigger: schedule.trigger, templateId: 'morning_inbox_digest' },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().schedule.id, schedule.id);
    assert.equal(createdInput?.runTemplate.templateId, 'morning_inbox_digest');

    const feedCreated = await app.inject({
      method: 'POST', url: '/scheduled-work-items',
      headers: { 'x-los-operator-token': 'operator-token' },
      payload: {
        title: 'Scheduled feed analysis', trigger: schedule.trigger,
        templateId: 'scheduled_feed_analysis', approvalPolicy: 'preapproved_scope',
        feedAnalysisRequest: {
          sourceSystem: 'lot2extension', deliveryMode: 'result_returning',
          materialBundle: {
            schemaVersion: 'material-bundle-v1', bundleId: 'scheduled-bundle',
            sourceSystem: 'lot2extension', items: [{ itemId: 'source-1', platform: 'x' }],
          },
        },
      },
    });
    assert.equal(feedCreated.statusCode, 201);
    assert.equal(createdInput?.runTemplate.templateId, 'scheduled_feed_analysis');
    assert.equal(createdInput?.runTemplate.feedAnalysisRequest?.sourceSystem, 'lot2extension');

    const detail = await app.inject({
      method: 'GET', url: `/scheduled-work-items/${schedule.id}`,
      headers: { 'x-los-auth-token': 'access-token' },
    });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().runs.length, 1);

    const triggered = await app.inject({
      method: 'POST', url: `/scheduled-work-items/${schedule.id}/trigger`,
      headers: { 'x-los-operator-token': 'operator-token' }, payload: {},
    });
    assert.equal(triggered.statusCode, 200);
    assert.equal(triggerCount, 1);
  } finally {
    setConfig(original);
    await app.close();
  }
});

function fixtureSchedule() {
  return {
    id: 'schedule-1', tenantId: 'local', projectId: 'los', title: 'Morning digest', status: 'enabled' as const,
    trigger: { kind: 'cron' as const, expression: '0 8 * * *', timezone: 'Asia/Shanghai' },
    runTemplate: {
      templateId: 'morning_inbox_digest' as const, mode: 'audit' as const,
      goalTemplate: 'Summarize Inbox', editableSurfaces: [], requiredChecks: [], toolMode: 'read-only' as const,
    },
    approvalPolicy: 'read_only_auto' as const, concurrencyPolicy: 'skip' as const, catchUpPolicy: 'skip' as const,
    maxConcurrentRuns: 1, maxLatenessMs: 3_600_000, maxAttempts: 2, retryBackoffMs: 60_000,
    failureThreshold: 3, nextRunAt: '2026-07-20T00:00:00.000Z', circuitState: 'closed' as const,
    consecutiveFailures: 0, consecutiveNoOps: 0, revision: 1, metadata: {},
    createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z',
  };
}
