import assert from 'node:assert/strict';
import test from 'node:test';

import { getDb } from '@los/infra/db';

import {
  claimDueScheduledWorkItems,
  claimQueuedScheduledWorkRuns,
  createScheduledWorkItem,
  heartbeatScheduledWorkRun,
  loadScheduledWorkItem,
  loadScheduledWorkItemRun,
  _deriveScheduledFeedAnalysisDispatch,
  previewScheduledOccurrences,
  recordScheduledRunOutcome,
  recoverExpiredScheduledWorkRuns,
  recoverOpenScheduledWorkCircuits,
  shouldSkipLateRun,
  transitionScheduledWorkRun,
} from './scheduled-work/index.js';
import { createTaskRun, ensureTaskRunStore } from './task-runs.js';
import {
  _FLEET_OBSERVATION_MAX_SCHEDULE_LATENESS_MS,
  _shouldRecordFleetObservation,
} from './scheduled-work/run-handlers.js';

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

test('late scheduled readiness runs do not advance fleet observations after sleep', () => {
  const scheduledFor = '2026-08-11T11:41:56.000Z';
  const withinGrace = new Date(
    Date.parse(scheduledFor) + _FLEET_OBSERVATION_MAX_SCHEDULE_LATENESS_MS,
  );
  assert.equal(
    _shouldRecordFleetObservation({ scheduledFor, triggerKind: 'scheduled' }, withinGrace),
    true,
  );
  assert.equal(
    _shouldRecordFleetObservation({ scheduledFor, triggerKind: 'scheduled' }, new Date('2026-08-11T11:45:01.000Z')),
    false,
  );
  assert.equal(
    _shouldRecordFleetObservation({ scheduledFor, triggerKind: 'manual' }, new Date('2026-08-11T12:45:01.000Z')),
    true,
  );
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

test('expired lease recovery skips runs with an active schedule-exec task', async () => {
  // Regression for 2026-08-09: 60s lease expiry reclaimed a still-running
  // scheduled_execution, second execute hit schedule-exec-${run.id} dedupe and
  // marked the run failed while the first task succeeded.
  await ensureTaskRunStore();
  const schedule = await createScheduledWorkItem({
    projectId: 'los', title: `scheduled-dedupe-skip-${Date.now()}`,
    trigger: { kind: 'once', expression: '2026-07-20T00:01:00.000Z', timezone: 'UTC' },
    runTemplate: {
      templateId: 'morning_inbox_digest', mode: 'audit',
      goalTemplate: 'Summarize Inbox', editableSurfaces: [], requiredChecks: [], toolMode: 'read-only',
    },
    catchUpPolicy: 'run_once', maxAttempts: 3, now: new Date('2026-07-20T00:00:00.000Z'),
  });
  let taskId: string | undefined;
  try {
    const [run] = await claimDueScheduledWorkItems({
      ownerId: 'scheduler-a', now: new Date('2026-07-20T00:02:00.000Z'), leaseMs: 500,
    });
    assert.ok(run);
    await transitionScheduledWorkRun(run!.id, 'running', {
      ownerId: 'scheduler-a',
      leaseExpiresAt: new Date('2026-07-20T00:02:00.500Z'),
    });
    taskId = `task-schedule-exec-${Date.now()}`;
    await createTaskRun({
      id: taskId,
      sessionId: `session-${taskId}`,
      dedupeKey: `schedule-exec-${run!.id}`,
      workspaceRoot: process.cwd(),
      toolMode: 'read-only',
      promptPreview: 'active schedule-exec fixture',
      status: 'running',
    });

    const recovery = await recoverExpiredScheduledWorkRuns({
      ownerId: 'scheduler-b', now: new Date('2026-07-20T00:02:05.000Z'), leaseMs: 1_000,
    });
    assert.equal(recovery.recovered.length, 0, 'must not reclaim while schedule-exec task is active');
    assert.equal(recovery.exhausted.length, 0);
    const still = await loadScheduledWorkItemRun(run!.id);
    assert.equal(still?.status, 'running');
    assert.equal(still?.claimOwner, 'scheduler-a');
    assert.equal(still?.attemptCount, 1);
  } finally {
    if (taskId) await getDb().query('DELETE FROM task_runs WHERE id=$1', [taskId]);
    await getDb().query('DELETE FROM scheduled_work_items WHERE id=$1', [schedule.id]);
  }
});

test('expired lease recovery finalizes runs whose schedule-exec task already succeeded', async () => {
  await ensureTaskRunStore();
  const schedule = await createScheduledWorkItem({
    projectId: 'los', title: `scheduled-finalize-${Date.now()}`,
    trigger: { kind: 'once', expression: '2026-07-20T00:01:00.000Z', timezone: 'UTC' },
    runTemplate: {
      templateId: 'morning_inbox_digest', mode: 'audit',
      goalTemplate: 'Summarize Inbox', editableSurfaces: [], requiredChecks: [], toolMode: 'read-only',
    },
    catchUpPolicy: 'run_once', maxAttempts: 3, now: new Date('2026-07-20T00:00:00.000Z'),
  });
  let taskId: string | undefined;
  try {
    const [run] = await claimDueScheduledWorkItems({
      ownerId: 'scheduler-a', now: new Date('2026-07-20T00:02:00.000Z'), leaseMs: 500,
    });
    assert.ok(run);
    await transitionScheduledWorkRun(run!.id, 'running', {
      ownerId: 'scheduler-a',
      leaseExpiresAt: new Date('2026-07-20T00:02:00.500Z'),
    });
    taskId = `task-schedule-done-${Date.now()}`;
    await createTaskRun({
      id: taskId,
      sessionId: `session-${taskId}`,
      dedupeKey: `schedule-exec-${run!.id}`,
      workspaceRoot: process.cwd(),
      toolMode: 'read-only',
      promptPreview: 'terminal schedule-exec fixture',
      status: 'succeeded',
    });

    const recovery = await recoverExpiredScheduledWorkRuns({
      ownerId: 'scheduler-b', now: new Date('2026-07-20T00:02:05.000Z'), leaseMs: 1_000,
    });
    assert.equal(recovery.recovered.length, 0, 'must not re-execute after agent already succeeded');
    const sealed = await loadScheduledWorkItemRun(run!.id);
    assert.equal(sealed?.status, 'succeeded');
    assert.equal(sealed?.taskRunId, taskId);
  } finally {
    if (taskId) await getDb().query('DELETE FROM task_runs WHERE id=$1', [taskId]);
    await getDb().query('DELETE FROM scheduled_work_items WHERE id=$1', [schedule.id]);
  }
});

test('execution lease heartbeat renews a running scheduled work run', async () => {
  const schedule = await createScheduledWorkItem({
    projectId: 'los', title: `scheduled-heartbeat-${Date.now()}`,
    trigger: { kind: 'once', expression: '2026-07-20T00:01:00.000Z', timezone: 'UTC' },
    runTemplate: {
      templateId: 'morning_inbox_digest', mode: 'audit',
      goalTemplate: 'Summarize Inbox', editableSurfaces: [], requiredChecks: [], toolMode: 'read-only',
    },
    catchUpPolicy: 'run_once', maxAttempts: 2, now: new Date('2026-07-20T00:00:00.000Z'),
  });
  try {
    const [run] = await claimDueScheduledWorkItems({
      ownerId: 'scheduler-a', now: new Date('2026-07-20T00:02:00.000Z'), leaseMs: 1_000,
    });
    assert.ok(run);
    const started = new Date('2026-07-20T00:02:00.000Z');
    await transitionScheduledWorkRun(run!.id, 'running', {
      ownerId: 'scheduler-a',
      leaseExpiresAt: new Date(started.getTime() + 1_000),
    });
    const renewedAt = new Date('2026-07-20T00:02:30.000Z');
    const heartbeated = await heartbeatScheduledWorkRun({
      runId: run!.id,
      ownerId: 'scheduler-a',
      now: renewedAt,
      leaseMs: 30 * 60_000,
    });
    assert.ok(heartbeated?.leaseExpiresAt);
    assert.equal(
      new Date(heartbeated!.leaseExpiresAt!).getTime(),
      renewedAt.getTime() + 30 * 60_000,
    );

    // Wrong owner must not renew.
    const stolen = await heartbeatScheduledWorkRun({
      runId: run!.id,
      ownerId: 'scheduler-b',
      now: renewedAt,
      leaseMs: 30 * 60_000,
    });
    assert.equal(stolen, null);
  } finally {
    await getDb().query('DELETE FROM scheduled_work_items WHERE id=$1', [schedule.id]);
  }
});

test('due and queued claims share the schedule concurrency lock', async () => {
  const now = new Date('2026-07-20T00:02:00.000Z');
  const schedule = await createScheduledWorkItem({
    projectId: 'los', title: `scheduled-claim-race-${Date.now()}`,
    trigger: { kind: 'once', expression: '2026-07-20T00:01:00.000Z', timezone: 'UTC' },
    runTemplate: {
      templateId: 'morning_inbox_digest', mode: 'audit', goalTemplate: 'Summarize Inbox',
      editableSurfaces: [], requiredChecks: [], toolMode: 'read-only',
    },
    catchUpPolicy: 'run_once', maxConcurrentRuns: 1,
    now: new Date('2026-07-20T00:00:00.000Z'),
  });
  try {
    await getDb().query(
      `INSERT INTO scheduled_work_item_runs
         (id,schedule_id,scheduled_for,trigger_kind,status,attempt_count,max_attempts,result_summary_json)
       VALUES ($1,$2,$3,'retry','queued',1,2,'{}'::jsonb)`,
      [`scheduled-queued-race-${Date.now()}`, schedule.id, '2026-07-20T00:00:30.000Z'],
    );
    const [due, queued] = await Promise.all([
      claimDueScheduledWorkItems({ ownerId: 'due-owner', now, limit: 1 }),
      claimQueuedScheduledWorkRuns({ ownerId: 'queued-owner', now, limit: 1 }),
    ]);
    const active = await getDb().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM scheduled_work_item_runs
       WHERE schedule_id=$1 AND status IN ('queued','claimed','running','awaiting_approval')`,
      [schedule.id],
    );
    assert.ok(Number(active.rows[0]!.count) <= 1, `active runs exceeded limit: due=${due.length}, queued=${queued.length}`);
    assert.equal(due.length + queued.length, 1, 'exactly one claim should reserve the single slot');
  } finally {
    await getDb().query('DELETE FROM scheduled_work_items WHERE id=$1', [schedule.id]);
  }
});

test('queued claims honor maxConcurrentRuns greater than one', async () => {
  const schedule = await createScheduledWorkItem({
    projectId: 'los', title: `scheduled-claim-cap-${Date.now()}`,
    trigger: { kind: 'interval', expression: '1h', timezone: 'UTC' },
    runTemplate: {
      templateId: 'morning_inbox_digest', mode: 'audit', goalTemplate: 'Summarize Inbox',
      editableSurfaces: [], requiredChecks: [], toolMode: 'read-only',
    },
    maxConcurrentRuns: 2,
  });
  try {
    for (let index = 0; index < 3; index += 1) {
      await getDb().query(
        `INSERT INTO scheduled_work_item_runs
           (id,schedule_id,scheduled_for,trigger_kind,status,attempt_count,max_attempts,result_summary_json)
         VALUES ($1,$2,$3,'retry','queued',1,2,'{}'::jsonb)`,
        [`scheduled-queued-cap-${Date.now()}-${index}`, schedule.id,
          new Date(Date.now() + index * 1_000)],
      );
    }
    const claimed = await claimQueuedScheduledWorkRuns({ ownerId: 'queued-owner', limit: 10 });
    assert.equal(claimed.length, 2);
    const pending = await getDb().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM scheduled_work_item_runs
       WHERE schedule_id=$1 AND status='queued'`,
      [schedule.id],
    );
    assert.equal(pending.rows[0]!.count, '1');
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

test('each_run approval queues the run and the tick loop executes it (async approval)', async () => {
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
      claimQueuedScheduledWorkRuns,
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

    // A3: approve marks the run approved and queues it (no synchronous execution).
    const approved = await approveScheduledWorkRun(run.id, { ownerId: 'operator' });
    assert.equal(approved.status, 'queued', `expected queued, got ${approved.status}`);
    assert.equal(approved.resultSummary?.approvedBy, 'operator');

    // The scheduled-work tick loop picks up queued runs and executes them;
    // the approval gate must let the approved run through.
    const queued = await claimQueuedScheduledWorkRuns({ ownerId: 'scheduler', limit: 10 });
    const picked = queued.find(item => item.id === run.id);
    assert.ok(picked, 'queued run must be claimed by the tick loop');
    const executed = await executeScheduledWorkRun(picked);
    assert.ok(['succeeded', 'no_op'].includes(executed),
      `expected execution outcome, got ${executed}`);
    const finalRun = await loadScheduledWorkItemRun(run.id);
    assert.equal(finalRun?.resultSummary?.approvedBy, 'operator',
      'approvedBy marker must survive the tick claim and execution');
  } finally {
    await getDb().query('DELETE FROM scheduled_work_items WHERE id=$1', [schedule.id]);
  }
});

test('approve rejects runs that are not awaiting_approval', async () => {  const schedule = await createScheduledWorkItem({
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

test('awaiting_approval emits an operator attention event for notification consumers', async () => {
  const schedule = await createScheduledWorkItem({
    projectId: 'los', title: `scheduled-notify-${Date.now()}`,
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
      createManualScheduledWorkRun,
      executeScheduledWorkRun,
    } = await import('./scheduled-work/index.js');
    const run = await createManualScheduledWorkRun({
      scheduleId: schedule.id, ownerId: 'scheduler-a', scheduledFor: new Date('2026-07-20T00:01:00.000Z'),
    });
    const outcome = await executeScheduledWorkRun(run);
    assert.equal(outcome, 'awaiting_approval');
    const rows = await getDb().query(
      `SELECT payload_json FROM session_events
       WHERE type='run.operator_attention_required' AND source='scheduled-work'
         AND payload_json::text LIKE '%' || $1 || '%'
       ORDER BY id DESC LIMIT 1`,
      [run.id],
    );
    assert.ok(rows.rows.length > 0, 'an operator attention event must be emitted for the awaiting run');
    const raw = rows.rows[0]!.payload_json as unknown;
    const payload = typeof raw === 'string' ? JSON.parse(raw) : raw as Record<string, unknown>;
    assert.equal(payload.runId, run.id);
    assert.equal(payload.scheduleId, schedule.id);
    assert.ok(payload.scheduleTitle);
  } finally {
    await getDb().query('DELETE FROM scheduled_work_items WHERE id=$1', [schedule.id]);
  }
});

test('approving a run recovers the slot skipped by concurrency_limit as an approved catch-up run', async () => {
  const schedule = await createScheduledWorkItem({
    projectId: 'los', title: `scheduled-catchup-${Date.now()}`,
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
      claimQueuedScheduledWorkRuns,
      createManualScheduledWorkRun,
      executeScheduledWorkRun,
      loadScheduledWorkItemRun,
    } = await import('./scheduled-work/index.js');
    const run = await createManualScheduledWorkRun({
      scheduleId: schedule.id, ownerId: 'scheduler-a', scheduledFor: new Date('2026-07-20T00:01:00.000Z'),
    });
    await executeScheduledWorkRun(run);
    assert.equal((await loadScheduledWorkItemRun(run.id))?.status, 'awaiting_approval');

    // Simulate a later slot skipped by concurrency_limit while the run waited.
    const skipped = await getDb().query(
      `INSERT INTO scheduled_work_item_runs (
         id, schedule_id, scheduled_for, trigger_kind, status, attempt_count, max_attempts,
         result_summary_json, completed_at
       ) VALUES ($1,$2,$3,'scheduled','skipped',1,2,$4::jsonb,now())
       RETURNING id`,
      [`schedule-run-skipped-${Date.now()}`, schedule.id, '2026-07-20T02:00:00.000Z',
        JSON.stringify({ reason: 'concurrency_limit' })],
    );
    const skippedId = skipped.rows[0]!.id as string;

    const approved = await approveScheduledWorkRun(run.id, { ownerId: 'operator' });
    assert.equal(approved.status, 'queued');

    // The missed slot must be marked as recovered so a later approval cannot
    // create a duplicate catch-up run.
    const marked = await getDb().query(
      `SELECT result_summary_json->>'caughtUpBy' AS caught_up_by
       FROM scheduled_work_item_runs WHERE id=$1`,
      [skippedId],
    );
    assert.ok(marked.rows[0]?.caught_up_by, 'missed slot must be marked caughtUpBy');

    // The catch-up run must be queued, approved (no second approval round trip)
    // and reference the missed slot.
    let queued = await claimQueuedScheduledWorkRuns({ ownerId: 'scheduler', limit: 10 });
    let catchUp = queued.find(item => item.triggerKind === 'retry');
    // maxConcurrentRuns=1 means the originally approved slot may occupy the
    // only claim slot first; the catch-up is then picked by the next tick.
    if (!catchUp) {
      for (const item of queued) await executeScheduledWorkRun(item);
      queued = await claimQueuedScheduledWorkRuns({ ownerId: 'scheduler', limit: 10 });
      catchUp = queued.find(item => item.triggerKind === 'retry');
    }
    assert.ok(catchUp, 'a catch-up run must be queued after approval');
    assert.equal(catchUp.resultSummary?.approvedBy, 'operator');
    assert.equal(catchUp.resultSummary?.catchUpOf, skippedId);
    assert.equal(marked.rows[0]!.caught_up_by, catchUp.id,
      'caughtUpBy must point at the catch-up run');
    const executed = await executeScheduledWorkRun(catchUp);
    assert.ok(['succeeded', 'no_op'].includes(executed),
      `catch-up run must execute without another approval, got ${executed}`);

    // A second approval must not recover the same missed slot again.
    const again = await getDb().query(
      `SELECT count(*)::int AS n FROM scheduled_work_item_runs
       WHERE schedule_id=$1 AND status='skipped' AND scheduled_for > $2
         AND result_summary_json->>'reason'='concurrency_limit'
         AND result_summary_json->>'caughtUpBy' IS NULL`,
      [schedule.id, '2026-07-20T00:01:00.000Z'],
    );
    assert.equal(again.rows[0]!.n, 0, 'recovered slot must not be found again');
  } finally {
    await getDb().query('DELETE FROM scheduled_work_items WHERE id=$1', [schedule.id]);
  }
});

test('approval timeout auto-denies stale awaiting runs by default and records audit', async () => {
  const schedule = await createScheduledWorkItem({
    projectId: 'los', title: `scheduled-timeout-deny-${Date.now()}`,
    trigger: { kind: 'once', expression: '2026-07-20T00:01:00.000Z', timezone: 'UTC' },
    runTemplate: {
      templateId: 'morning_inbox_digest', mode: 'audit',
      goalTemplate: 'Summarize Inbox', editableSurfaces: [], requiredChecks: [], toolMode: 'read-only',
    },
    approvalPolicy: 'each_run', catchUpPolicy: 'run_once', maxAttempts: 2,
    approvalTimeoutMs: 30_000, approvalTimeoutAction: 'deny',
    now: new Date('2026-07-20T00:00:00.000Z'),
  });
  try {
    const {
      createManualScheduledWorkRun,
      executeScheduledWorkRun,
      expireAwaitingApprovalRuns,
      loadScheduledWorkItemRun,
    } = await import('./scheduled-work/index.js');
    const run = await createManualScheduledWorkRun({
      scheduleId: schedule.id, ownerId: 'scheduler-a', scheduledFor: new Date('2026-07-20T00:01:00.000Z'),
    });
    await executeScheduledWorkRun(run);
    assert.equal((await loadScheduledWorkItemRun(run.id))?.status, 'awaiting_approval');

    // Not yet timed out → untouched.
    const early = await expireAwaitingApprovalRuns({ ownerId: 'scheduler', now: new Date() });
    assert.deepEqual(early, { autoApproved: [], autoDenied: [] });
    assert.equal((await loadScheduledWorkItemRun(run.id))?.status, 'awaiting_approval');

    // Simulate the run waiting past its approval timeout, then sweep.
    await getDb().query(
      `UPDATE scheduled_work_item_runs SET updated_at = now() - interval '31 seconds' WHERE id=$1`,
      [run.id],
    );
    const expired = await expireAwaitingApprovalRuns({ ownerId: 'scheduler', now: new Date() });
    assert.deepEqual(expired.autoDenied, [run.id]);
    const denied = await loadScheduledWorkItemRun(run.id);
    assert.equal(denied?.status, 'cancelled');
    assert.equal(denied?.resultSummary?.deniedBy, 'auto:approval_timeout');
    assert.equal(denied?.resultSummary?.deniedReason, 'approval_timeout');

    // Audit event with actor and action.
    const rows = await getDb().query(
      `SELECT payload_json FROM session_events
       WHERE type='scheduled_work.denied' AND source='scheduled-work'
         AND payload_json::text LIKE '%' || $1 || '%'
       ORDER BY id DESC LIMIT 1`,
      [run.id],
    );
    assert.ok(rows.rows.length > 0, 'denial audit event must be recorded');
    const raw = rows.rows[0]!.payload_json as unknown;
    const payload = typeof raw === 'string' ? JSON.parse(raw) : raw as Record<string, unknown>;
    assert.equal(payload.actor, 'auto:approval_timeout');
    assert.equal(payload.action, 'denied');
    assert.equal(payload.approvalTimeoutMs, 30_000);
  } finally {
    await getDb().query('DELETE FROM scheduled_work_items WHERE id=$1', [schedule.id]);
  }
});

test('approval timeout auto-approves when the schedule opts in', async () => {
  const schedule = await createScheduledWorkItem({
    projectId: 'los', title: `scheduled-timeout-approve-${Date.now()}`,
    trigger: { kind: 'once', expression: '2026-07-20T00:01:00.000Z', timezone: 'UTC' },
    runTemplate: {
      templateId: 'morning_inbox_digest', mode: 'audit',
      goalTemplate: 'Summarize Inbox', editableSurfaces: [], requiredChecks: [], toolMode: 'read-only',
    },
    approvalPolicy: 'each_run', catchUpPolicy: 'run_once', maxAttempts: 2,
    approvalTimeoutMs: 30_000, approvalTimeoutAction: 'approve',
    now: new Date('2026-07-20T00:00:00.000Z'),
  });
  try {
    const {
      createManualScheduledWorkRun,
      executeScheduledWorkRun,
      expireAwaitingApprovalRuns,
      loadScheduledWorkItemRun,
    } = await import('./scheduled-work/index.js');
    const run = await createManualScheduledWorkRun({
      scheduleId: schedule.id, ownerId: 'scheduler-a', scheduledFor: new Date('2026-07-20T00:01:00.000Z'),
    });
    await executeScheduledWorkRun(run);
    await getDb().query(
      `UPDATE scheduled_work_item_runs SET updated_at = now() - interval '31 seconds' WHERE id=$1`,
      [run.id],
    );
    const expired = await expireAwaitingApprovalRuns({ ownerId: 'scheduler', now: new Date() });
    assert.deepEqual(expired.autoApproved, [run.id]);
    const approved = await loadScheduledWorkItemRun(run.id);
    assert.equal(approved?.status, 'queued');
    assert.equal(approved?.resultSummary?.approvedBy, 'auto:approval_timeout');
  } finally {
    await getDb().query('DELETE FROM scheduled_work_items WHERE id=$1', [schedule.id]);
  }
});

test('denyScheduledWorkRun cancels an awaiting run and records the denial', async () => {
  const schedule = await createScheduledWorkItem({
    projectId: 'los', title: `scheduled-deny-${Date.now()}`,
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
      createManualScheduledWorkRun,
      denyScheduledWorkRun,
      executeScheduledWorkRun,
      loadScheduledWorkItemRun,
    } = await import('./scheduled-work/index.js');
    const run = await createManualScheduledWorkRun({
      scheduleId: schedule.id, ownerId: 'scheduler-a', scheduledFor: new Date('2026-07-20T00:01:00.000Z'),
    });
    await executeScheduledWorkRun(run);
    const cancelled = await denyScheduledWorkRun(run.id, { ownerId: 'manual:operator' });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal((await loadScheduledWorkItemRun(run.id))?.resultSummary?.deniedBy, 'manual:operator');
    await assert.rejects(
      denyScheduledWorkRun(run.id, { ownerId: 'manual:operator' }),
      /must be awaiting_approval/,
    );
  } finally {
    await getDb().query('DELETE FROM scheduled_work_items WHERE id=$1', [schedule.id]);
  }
});

test('manual trigger refuses when maxConcurrentRuns is exhausted (skip policy)', async () => {
  const schedule = await createScheduledWorkItem({
    projectId: 'los', title: `scheduled-manual-skip-${Date.now()}`,
    trigger: { kind: 'once', expression: '2026-07-20T00:01:00.000Z', timezone: 'UTC' },
    runTemplate: {
      templateId: 'morning_inbox_digest', mode: 'audit',
      goalTemplate: 'Summarize Inbox', editableSurfaces: [], requiredChecks: [], toolMode: 'read-only',
    },
    approvalPolicy: 'read_only_auto', concurrencyPolicy: 'skip',
    catchUpPolicy: 'run_once', maxAttempts: 2, maxConcurrentRuns: 1,
    now: new Date('2026-07-20T00:00:00.000Z'),
  });
  try {
    const { createManualScheduledWorkRun } = await import('./scheduled-work/index.js');
    const first = await createManualScheduledWorkRun({
      scheduleId: schedule.id, ownerId: 'scheduler-a',
    });
    assert.equal(first.status, 'claimed');
    // A second manual trigger while the first run is active must be refused
    // (manual runs share the same ledger and concurrency policy, ADR 0034).
    await assert.rejects(
      createManualScheduledWorkRun({
        scheduleId: schedule.id, ownerId: 'scheduler-a',
        scheduledFor: new Date(Date.now() + 1000),
      }),
      /concurrency limit reached/,
    );
    // After the run becomes terminal, manual triggering works again.
    await getDb().query(
      `UPDATE scheduled_work_item_runs SET status='succeeded', completed_at=now() WHERE id=$1`,
      [first.id],
    );
    const second = await createManualScheduledWorkRun({
      scheduleId: schedule.id, ownerId: 'scheduler-a',
      scheduledFor: new Date(Date.now() + 2000),
    });
    assert.equal(second.status, 'claimed');
  } finally {
    await getDb().query('DELETE FROM scheduled_work_items WHERE id=$1', [schedule.id]);
  }
});

test('manual trigger queues instead of claiming under queue_one when the slot is busy', async () => {
  const schedule = await createScheduledWorkItem({
    projectId: 'los', title: `scheduled-manual-queue-${Date.now()}`,
    trigger: { kind: 'once', expression: '2026-07-20T00:01:00.000Z', timezone: 'UTC' },
    runTemplate: {
      templateId: 'morning_inbox_digest', mode: 'audit',
      goalTemplate: 'Summarize Inbox', editableSurfaces: [], requiredChecks: [], toolMode: 'read-only',
    },
    approvalPolicy: 'read_only_auto', concurrencyPolicy: 'queue_one',
    catchUpPolicy: 'run_once', maxAttempts: 2, maxConcurrentRuns: 1,
    now: new Date('2026-07-20T00:00:00.000Z'),
  });
  try {
    const { claimQueuedScheduledWorkRuns, createManualScheduledWorkRun } = await import('./scheduled-work/index.js');
    const first = await createManualScheduledWorkRun({ scheduleId: schedule.id, ownerId: 'scheduler-a' });
    const queued = await createManualScheduledWorkRun({
      scheduleId: schedule.id, ownerId: 'scheduler-a',
      scheduledFor: new Date(Date.now() + 1000),
    });
    assert.equal(queued.status, 'queued');
    assert.equal(queued.claimOwner, undefined, 'queued run must not carry a lease owner');

    // While the claimed run is active, the tick must NOT claim the queued one
    // (maxConcurrentRuns still applies to queued claims).
    const busy = await claimQueuedScheduledWorkRuns({ ownerId: 'scheduler', limit: 10 });
    assert.ok(!busy.some(r => r.id === queued.id),
      'queued run must wait while the active slot is occupied');

    // Once the active run is terminal, the tick loop picks the queued run up.
    await getDb().query(
      `UPDATE scheduled_work_item_runs SET status='succeeded', completed_at=now() WHERE id=$1`,
      [first.id],
    );
    const claimed = await claimQueuedScheduledWorkRuns({ ownerId: 'scheduler', limit: 10 });
    assert.ok(claimed.some(r => r.id === queued.id),
      'queued manual run must be claimable once the active slot frees up');
  } finally {
    await getDb().query('DELETE FROM scheduled_work_items WHERE id=$1', [schedule.id]);
  }
});
