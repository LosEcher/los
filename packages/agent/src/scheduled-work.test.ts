import assert from 'node:assert/strict';
import test from 'node:test';

import { getDb } from '@los/infra/db';

import {
  claimDueScheduledWorkItems,
  createScheduledWorkItem,
  _deriveScheduledFeedAnalysisDispatch,
  previewScheduledOccurrences,
  recordScheduledRunOutcome,
  recoverExpiredScheduledWorkRuns,
  shouldSkipLateRun,
} from './scheduled-work/index.js';

test('scheduled trigger preview handles DST gaps and overlaps deterministically', () => {
  const spring = previewScheduledOccurrences({
    kind: 'cron', expression: '30 2 * * *', timezone: 'America/New_York',
  }, new Date('2026-03-08T00:00:00.000Z'), 1);
  assert.deepEqual(spring, ['2026-03-09T06:30:00.000Z']);

  const fall = previewScheduledOccurrences({
    kind: 'cron', expression: '30 1 * * *', timezone: 'America/New_York',
  }, new Date('2026-11-01T00:00:00.000Z'), 2);
  assert.deepEqual(fall, ['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z']);
});

test('catch-up policy skips only stale skip-policy slots', () => {
  const slot = new Date('2026-07-19T00:00:00.000Z');
  const now = new Date('2026-07-19T02:00:00.000Z');
  assert.equal(shouldSkipLateRun(slot, now, 60_000, 'skip'), true);
  assert.equal(shouldSkipLateRun(slot, now, 60_000, 'run_once'), false);
});

test('due schedule claim is unique and an expired lease consumes one retry attempt', async () => {
  const schedule = await createScheduledWorkItem({
    projectId: 'los', title: `scheduled-claim-${Date.now()}`,
    trigger: { kind: 'once', expression: '2026-07-20T00:01:00.000Z', timezone: 'UTC' },
    runTemplate: {
      templateId: 'morning_inbox_digest', mode: 'audit',
      goalTemplate: 'Summarize Inbox', editableSurfaces: [], requiredChecks: [], toolMode: 'read-only',
    },
    catchUpPolicy: 'run_once', maxAttempts: 2, now: new Date('2026-07-20T00:00:00.000Z'),
  });
  try {
    const first = await claimDueScheduledWorkItems({
      ownerId: 'scheduler-a', now: new Date('2026-07-20T00:02:00.000Z'), leaseMs: 1_000,
    });
    const second = await claimDueScheduledWorkItems({
      ownerId: 'scheduler-b', now: new Date('2026-07-20T00:02:00.000Z'), leaseMs: 1_000,
    });
    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
    assert.equal(first[0]?.scheduleId, schedule.id);

    const recovery = await recoverExpiredScheduledWorkRuns({
      ownerId: 'scheduler-b', now: new Date('2026-07-20T00:02:02.000Z'), leaseMs: 1_000,
    });
    assert.equal(recovery.recovered.length, 1);
    assert.equal(recovery.recovered[0]?.attemptCount, 2);
    assert.equal(recovery.recovered[0]?.claimOwner, 'scheduler-b');
  } finally {
    await getDb().query('DELETE FROM scheduled_work_items WHERE id=$1', [schedule.id]);
  }
});

test('circuit reports exactly one open transition at the failure threshold', async () => {
  const schedule = await createScheduledWorkItem({
    projectId: 'los', title: `scheduled-circuit-${Date.now()}`,
    trigger: { kind: 'interval', expression: '1h', timezone: 'UTC' },
    runTemplate: {
      templateId: 'runtime_readiness', mode: 'governance',
      goalTemplate: 'Inspect runtime', editableSurfaces: [], requiredChecks: [], toolMode: 'read-only',
    },
    failureThreshold: 2,
  });
  try {
    const first = await recordScheduledRunOutcome({ scheduleId: schedule.id, status: 'failed' });
    const second = await recordScheduledRunOutcome({ scheduleId: schedule.id, status: 'failed' });
    const third = await recordScheduledRunOutcome({ scheduleId: schedule.id, status: 'failed' });
    assert.equal(first.circuitOpened, false);
    assert.equal(second.circuitOpened, true);
    assert.equal(second.schedule.circuitState, 'open');
    assert.equal(third.circuitOpened, false);
  } finally {
    await getDb().query('DELETE FROM scheduled_work_items WHERE id=$1', [schedule.id]);
  }
});

test('scheduled feed analysis requires preapproval and derives stable retry identity', async () => {
  const template = {
    templateId: 'scheduled_feed_analysis' as const,
    mode: 'audit' as const,
    goalTemplate: 'Analyze the scheduled evidence bundle',
    editableSurfaces: [],
    requiredChecks: [],
    toolMode: 'read-only' as const,
    feedAnalysisRequest: {
      sourceSystem: 'lot2extension',
      deliveryMode: 'result_returning' as const,
      scenario: 'evidence_batch',
      collectionSnapshot: { snapshotId: 'scheduled-snapshot', observationCount: 1 },
      requestedOutputs: ['daily_digest'],
      materialBundle: {
        schemaVersion: 'material-bundle-v1' as const,
        bundleId: 'scheduled-snapshot',
        sourceSystem: 'lot2extension',
        items: [{ itemId: 'source-1', platform: 'x' }],
      },
    },
  };
  await assert.rejects(
    createScheduledWorkItem({
      projectId: 'los', title: 'invalid scheduled feed',
      trigger: { kind: 'interval', expression: '1h', timezone: 'UTC' },
      runTemplate: template,
      approvalPolicy: 'read_only_auto',
    }),
    /requires preapproved_scope/,
  );
  const schedule = await createScheduledWorkItem({
    projectId: 'los', title: `scheduled-feed-${Date.now()}`,
    trigger: { kind: 'interval', expression: '1h', timezone: 'UTC' },
    runTemplate: template,
    approvalPolicy: 'preapproved_scope',
  });
  try {
    const run = {
      id: 'schedule-run-first', scheduleId: schedule.id, scheduledFor: '2026-07-19T08:00:00.000Z',
      triggerKind: 'scheduled' as const, status: 'claimed' as const, attemptCount: 1, maxAttempts: 2,
      createdAt: '2026-07-19T08:00:00.000Z', updatedAt: '2026-07-19T08:00:00.000Z',
    };
    const first = _deriveScheduledFeedAnalysisDispatch(schedule, run);
    const retry = _deriveScheduledFeedAnalysisDispatch(schedule, {
      ...run, id: 'schedule-run-retry', triggerKind: 'retry', attemptCount: 2,
    });
    assert.equal(first.idempotencyKey, retry.idempotencyKey);
    assert.equal(first.request.sourceJobId, retry.request.sourceJobId);
    assert.equal(first.request.metadata?.scheduledWork instanceof Object, true);
  } finally {
    await getDb().query('DELETE FROM scheduled_work_items WHERE id=$1', [schedule.id]);
  }
});
