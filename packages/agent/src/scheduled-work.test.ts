import assert from 'node:assert/strict';
import test from 'node:test';

import { getDb } from '@los/infra/db';

import {
  claimDueScheduledWorkItems,
  createScheduledWorkItem,
  loadScheduledWorkItem,
  _deriveScheduledFeedAnalysisDispatch,
  previewScheduledOccurrences,
  recordScheduledRunOutcome,
  recoverExpiredScheduledWorkRuns,
  recoverOpenScheduledWorkCircuits,
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

test('open circuit auto-recovers to half_open after the window and closes on a successful probe', async () => {
  const openedAt = new Date();
  const slot = new Date(openedAt.getTime() + 3_600_000);
  const schedule = await createScheduledWorkItem({
    projectId: 'los', title: `scheduled-halfopen-${Date.now()}`,
    trigger: { kind: 'once', expression: slot.toISOString(), timezone: 'UTC' },
    runTemplate: {
      templateId: 'runtime_readiness', mode: 'governance',
      goalTemplate: 'Inspect runtime', editableSurfaces: [], requiredChecks: [], toolMode: 'read-only',
    },
    failureThreshold: 1, catchUpPolicy: 'run_once',
  });
  try {
    const opened = await recordScheduledRunOutcome({ scheduleId: schedule.id, status: 'failed' });
    assert.equal(opened.circuitOpened, true);
    assert.equal(opened.schedule.circuitState, 'open');
    assert.ok(opened.schedule.circuitOpenedAt, 'open circuit must record circuit_opened_at');
    const firstOpenedAt = new Date(opened.schedule.circuitOpenedAt!).getTime();

    // Open circuit never claims due slots.
    const during = await claimDueScheduledWorkItems({
      ownerId: 'scheduler-a', now: new Date(slot.getTime() + 60_000),
    });
    assert.equal(during.length, 0);

    // Recovery window not elapsed yet → still open.
    const early = await recoverOpenScheduledWorkCircuits({ now: new Date(slot.getTime() + 60_000) });
    assert.equal(early.length, 0);

    // Window elapsed → half_open, exactly one probe run becomes claimable.
    const afterWindow = new Date(firstOpenedAt + 24 * 3_600_000 + 60_000);
    const recovered = await recoverOpenScheduledWorkCircuits({ now: afterWindow });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]!.circuitState, 'half_open');

    const probe = await claimDueScheduledWorkItems({
      ownerId: 'scheduler-a', now: new Date(afterWindow.getTime() + 60_000), leaseMs: 60_000,
    });
    assert.equal(probe.length, 1);

    // Successful probe closes the circuit and resets the failure counter.
    const success = await recordScheduledRunOutcome({ scheduleId: schedule.id, status: 'succeeded' });
    assert.equal(success.schedule.circuitState, 'closed');
    assert.equal(success.schedule.consecutiveFailures, 0);
    assert.equal(success.schedule.circuitOpenedAt, undefined);
  } finally {
    await getDb().query('DELETE FROM scheduled_work_items WHERE id=$1', [schedule.id]);
  }
});

test('failed half_open probe re-opens the circuit and restarts the recovery window', async () => {
  const openedAt = new Date();
  const slot = new Date(openedAt.getTime() + 3_600_000);
  const schedule = await createScheduledWorkItem({
    projectId: 'los', title: `scheduled-probe-fail-${Date.now()}`,
    trigger: { kind: 'once', expression: slot.toISOString(), timezone: 'UTC' },
    runTemplate: {
      templateId: 'runtime_readiness', mode: 'governance',
      goalTemplate: 'Inspect runtime', editableSurfaces: [], requiredChecks: [], toolMode: 'read-only',
    },
    failureThreshold: 1, catchUpPolicy: 'run_once',
  });
  try {
    const opened = await recordScheduledRunOutcome({ scheduleId: schedule.id, status: 'failed' });
    assert.equal(opened.schedule.circuitState, 'open');
    const firstOpenedAt = new Date(opened.schedule.circuitOpenedAt!).getTime();

    const afterWindow = new Date(firstOpenedAt + 24 * 3_600_000 + 60_000);
    const recovered = await recoverOpenScheduledWorkCircuits({ now: afterWindow });
    assert.equal(recovered.length, 1);

    // Probe fails → back to open, window restarts, and no second recovery item.
    const probeFail = await recordScheduledRunOutcome({ scheduleId: schedule.id, status: 'failed' });
    assert.equal(probeFail.circuitOpened, false, 're-open after a probe must not create another recovery item');
    assert.equal(probeFail.schedule.circuitState, 'open');
    const reopenedAt = new Date(probeFail.schedule.circuitOpenedAt!).getTime();
    assert.ok(reopenedAt > firstOpenedAt, 'circuit_opened_at must restart at re-open, not keep the stale window start');
    assert.ok(Math.abs(reopenedAt - Date.now()) < 60_000,
      `circuit_opened_at must restart at re-open (got ${new Date(reopenedAt).toISOString()}, wall now ${new Date().toISOString()})`);

    // Fresh window must elapse before the circuit may recover again.
    const early = await recoverOpenScheduledWorkCircuits({ now: new Date(reopenedAt + 60_000) });
    assert.equal(early.length, 0);
  } finally {
    await getDb().query('DELETE FROM scheduled_work_items WHERE id=$1', [schedule.id]);
  }
});

test('no_op probe closes a half_open circuit like a successful one', async () => {
  const openedAt = new Date();
  const slot = new Date(openedAt.getTime() + 3_600_000);
  const schedule = await createScheduledWorkItem({
    projectId: 'los', title: `scheduled-noop-probe-${Date.now()}`,
    trigger: { kind: 'once', expression: slot.toISOString(), timezone: 'UTC' },
    runTemplate: {
      templateId: 'runtime_readiness', mode: 'governance',
      goalTemplate: 'Inspect runtime', editableSurfaces: [], requiredChecks: [], toolMode: 'read-only',
    },
    failureThreshold: 1, catchUpPolicy: 'run_once',
  });
  try {
    const opened = await recordScheduledRunOutcome({ scheduleId: schedule.id, status: 'failed' });
    const firstOpenedAt = new Date(opened.schedule.circuitOpenedAt!).getTime();
    const recovered = await recoverOpenScheduledWorkCircuits({ now: new Date(firstOpenedAt + 24 * 3_600_000 + 60_000) });
    assert.equal(recovered[0]?.circuitState, 'half_open');

    const noOp = await recordScheduledRunOutcome({ scheduleId: schedule.id, status: 'no_op' });
    assert.equal(noOp.schedule.circuitState, 'closed');
    assert.equal(noOp.schedule.consecutiveFailures, 0);
    assert.equal(noOp.schedule.consecutiveNoOps, 1);
    assert.equal(noOp.schedule.circuitOpenedAt, undefined);
  } finally {
    await getDb().query('DELETE FROM scheduled_work_items WHERE id=$1', [schedule.id]);
  }
});

test('concurrent probe outcomes never corrupt the circuit state', async () => {
  const openedAt = new Date();
  const slot = new Date(openedAt.getTime() + 3_600_000);
  const schedule = await createScheduledWorkItem({
    projectId: 'los', title: `scheduled-concurrent-probe-${Date.now()}`,
    trigger: { kind: 'once', expression: slot.toISOString(), timezone: 'UTC' },
    runTemplate: {
      templateId: 'runtime_readiness', mode: 'governance',
      goalTemplate: 'Inspect runtime', editableSurfaces: [], requiredChecks: [], toolMode: 'read-only',
    },
    failureThreshold: 1, catchUpPolicy: 'run_once',
  });
  try {
    const opened = await recordScheduledRunOutcome({ scheduleId: schedule.id, status: 'failed' });
    const firstOpenedAt = new Date(opened.schedule.circuitOpenedAt!).getTime();
    const recovered = await recoverOpenScheduledWorkCircuits({ now: new Date(firstOpenedAt + 24 * 3_600_000 + 60_000) });
    assert.equal(recovered[0]?.circuitState, 'half_open');

    // Two ticks finishing the same probe in opposite directions: the loser of
    // the optimistic write re-reads and recomputes, so the circuit ends in a
    // legal state instead of silently keeping a stale one. If success lands
    // first, the failed write sees the circuit closed and legitimately opens
    // it again (fresh open); if failure lands first, success closes it.
    const [ok, failed] = await Promise.all([
      recordScheduledRunOutcome({ scheduleId: schedule.id, status: 'succeeded' }),
      recordScheduledRunOutcome({ scheduleId: schedule.id, status: 'failed' }),
    ]);
    assert.equal(ok.circuitOpened, false, 'a success outcome never opens a circuit');
    const final = await loadScheduledWorkItem(schedule.id);
    assert.ok(final, 'schedule must still exist');
    assert.ok(['closed', 'open'].includes(final.circuitState), `circuit must end closed or open, got ${final.circuitState}`);
    if (final.circuitState === 'closed') assert.equal(final.consecutiveFailures, 0);
    if (final.circuitState === 'open') assert.ok(final.circuitOpenedAt, 're-opened circuit must record a fresh window start');
  } finally {
    await getDb().query('DELETE FROM scheduled_work_items WHERE id=$1', [schedule.id]);
  }
});

test('half_open claims at most one probe slot per tick even with overdue slots', async () => {
  const createdAt = new Date();
  const schedule = await createScheduledWorkItem({
    projectId: 'los', title: `scheduled-single-probe-${Date.now()}`,
    trigger: { kind: 'interval', expression: '1h', timezone: 'UTC' },
    runTemplate: {
      templateId: 'runtime_readiness', mode: 'governance',
      goalTemplate: 'Inspect runtime', editableSurfaces: [], requiredChecks: [], toolMode: 'read-only',
    },
    failureThreshold: 1, catchUpPolicy: 'run_once',
    now: createdAt,
  });
  try {
    const opened = await recordScheduledRunOutcome({ scheduleId: schedule.id, status: 'failed' });
    const firstOpenedAt = new Date(opened.schedule.circuitOpenedAt!).getTime();
    const recovered = await recoverOpenScheduledWorkCircuits({ now: new Date(firstOpenedAt + 24 * 3_600_000 + 60_000) });
    assert.equal(recovered[0]?.circuitState, 'half_open');

    // Three hourly slots are due; the probe claim must stop after the first.
    const claim = await claimDueScheduledWorkItems({
      ownerId: 'scheduler-a', now: new Date(firstOpenedAt + 24 * 3_600_000 + 3 * 3_600_000), leaseMs: 60_000,
    });
    assert.equal(claim.length, 1, 'half_open must allow exactly one probe slot per tick');
    assert.equal(claim[0]?.status, 'claimed');
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

test('scheduled_execution with empty requiredChecks throws', () => {
  const createSchedule = createScheduledWorkItem.bind(null, {
    projectId: 'los',
    title: `empty-checks-${Date.now()}`,
    trigger: { kind: 'once', expression: '2026-07-20T00:01:00.000Z', timezone: 'UTC' },
    runTemplate: {
      templateId: 'scheduled_execution',
      mode: 'execution',
      goalTemplate: 'Run task',
      editableSurfaces: ['src/'],
      requiredChecks: [],
      toolMode: 'project-write' as const,
    },
    approvalPolicy: 'preapproved_scope',
  });
  return assert.rejects(
    createSchedule(),
    /requires at least one required check/,
  );
});

test('scheduled_execution with requiredChecks passes validation', async () => {
  // Use a future one-shot trigger relative to the real clock — a fixed past
  // date (e.g. 2026-07-20) makes this fail once the date passes.
  const futureOnce = new Date(Date.now() + 60_000).toISOString();
  const schedule = await createScheduledWorkItem({
    projectId: 'los',
    title: `valid-checks-${Date.now()}`,
    trigger: { kind: 'once', expression: futureOnce, timezone: 'UTC' },
    runTemplate: {
      templateId: 'scheduled_execution',
      mode: 'execution',
      goalTemplate: 'Run task',
      editableSurfaces: ['src/'],
      requiredChecks: ['pnpm check'],
      toolMode: 'project-write' as const,
    },
    approvalPolicy: 'preapproved_scope',
  });
  try {
    assert.equal(schedule.runTemplate.requiredChecks.length, 1);
    assert.equal(schedule.runTemplate.requiredChecks[0], 'pnpm check');
  } finally {
    await getDb().query('DELETE FROM scheduled_work_items WHERE id=$1', [schedule.id]);
  }
});

test('each_run approval moves awaiting_approval run to execution', async () => {
  const schedule = await createScheduledWorkItem({
    projectId: 'los', title: `scheduled-approve-${Date.now()}`,
    trigger: { kind: 'once', expression: '2026-07-20T00:01:00.000Z', timezone: 'UTC' },
    runTemplate: {
      templateId: 'morning_inbox_digest', mode: 'audit',
      goalTemplate: 'Summarize Inbox', editableSurfaces: [], requiredChecks: [], toolMode: 'read-only',
    },
    approvalPolicy: 'each_run', catchUpPolicy: 'run_once', maxAttempts: 2,
    now: new Date('2026-07-20T00:00:00.000Z'),
  });
  try {
    const {
      approveScheduledWorkRun,
      createManualScheduledWorkRun,
      executeScheduledWorkRun,
      loadScheduledWorkItemRun,
    } = await import('./scheduled-work/index.js');
    const run = await createManualScheduledWorkRun({
      scheduleId: schedule.id, ownerId: 'scheduler-a', scheduledFor: new Date('2026-07-20T00:01:00.000Z'),
    });
    const outcome = await executeScheduledWorkRun(run);
    assert.equal(outcome, 'awaiting_approval');
    const pending = await loadScheduledWorkItemRun(run.id);
    assert.ok(pending, 'run must exist after awaiting_approval transition');
    assert.equal(pending.status, 'awaiting_approval');

    const approved = await approveScheduledWorkRun(run.id, { ownerId: 'operator' });
    assert.ok(['succeeded', 'no_op'].includes(approved.status),
      `expected execution outcome, got ${approved.status}`);
    assert.equal(approved.claimOwner, 'operator');
  } finally {
    await getDb().query('DELETE FROM scheduled_work_items WHERE id=$1', [schedule.id]);
  }
});

test('approve rejects runs that are not awaiting_approval', async () => {
  const schedule = await createScheduledWorkItem({
    projectId: 'los', title: `scheduled-approve-bad-${Date.now()}`,
    trigger: { kind: 'once', expression: '2026-07-20T00:01:00.000Z', timezone: 'UTC' },
    runTemplate: {
      templateId: 'morning_inbox_digest', mode: 'audit',
      goalTemplate: 'Summarize Inbox', editableSurfaces: [], requiredChecks: [], toolMode: 'read-only',
    },
    approvalPolicy: 'read_only_auto', catchUpPolicy: 'run_once', maxAttempts: 2,
    now: new Date('2026-07-20T00:00:00.000Z'),
  });
  try {
    const {
      approveScheduledWorkRun,
      createManualScheduledWorkRun,
      executeScheduledWorkRun,
    } = await import('./scheduled-work/index.js');
    const run = await createManualScheduledWorkRun({
      scheduleId: schedule.id, ownerId: 'scheduler-a', scheduledFor: new Date('2026-07-20T00:01:00.000Z'),
    });
    await executeScheduledWorkRun(run); // read_only_auto executes directly
    await assert.rejects(
      approveScheduledWorkRun(run.id, { ownerId: 'operator' }),
      /must be awaiting_approval/,
    );
  } finally {
    await getDb().query('DELETE FROM scheduled_work_items WHERE id=$1', [schedule.id]);
  }
});
