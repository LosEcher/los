import assert from 'node:assert/strict';
import test from 'node:test';

import { getDb } from '@los/infra/db';

import {
  _buildEvidenceWindow,
  _summarizeInbox,
  _summarizeProviderQuality,
  _summarizeRecovery,
  _summarizeSchedule,
} from './daily-agent-quality/metrics.js';
import {
  getDailyAgentQualityBaseline,
  upsertDailyAgentQualitySnapshot,
} from './daily-agent-quality/store.js';
import type { DailyAgentQualitySnapshot, DailyQualityMetricSources } from './daily-agent-quality/types.js';

const NOW = new Date('2026-07-19T12:00:00.000Z');

test('daily quality metrics keep attention, schedule, recovery, and provider evidence separate', () => {
  const inboxEntries: DailyQualityMetricSources['inboxEntries'] = [
    inbox('approval_required', '2026-07-19T11:00:00.000Z'),
    inbox('recovery_required', '2026-07-18T10:00:00.000Z'),
    inbox('verification_blocked', '2026-07-15T00:00:00.000Z'),
  ];
  const scheduleRuns: DailyQualityMetricSources['scheduleRuns'] = [
    scheduledRun('succeeded', 2, '2026-07-19T08:00:00.000Z', '2026-07-19T08:00:30.000Z'),
    scheduledRun('no_op', 1, '2026-07-19T09:00:00.000Z', '2026-07-19T09:01:00.000Z'),
    scheduledRun('failed', 1, '2026-07-19T10:00:00.000Z'),
  ];

  const inboxMetrics = _summarizeInbox(inboxEntries, NOW);
  assert.equal(inboxMetrics.actionableCount, 3);
  assert.equal(inboxMetrics.approvalRequired, 1);
  assert.equal(inboxMetrics.over24h, 2);
  assert.equal(inboxMetrics.over72h, 1);

  const scheduleMetrics = _summarizeSchedule(scheduleRuns);
  assert.equal(scheduleMetrics.runCount, 3);
  assert.equal(scheduleMetrics.noOpRate, 1 / 3);
  assert.equal(scheduleMetrics.failureRate, 1 / 3);
  assert.equal(scheduleMetrics.averageLatenessMs, 45_000);

  const recovery = _summarizeRecovery({
    inboxEntries,
    scheduleRuns,
    taskRetries: [{ attempt: 3, status: 'succeeded' }],
    recoveryEvents: 4,
  });
  assert.equal(recovery.requiredItems, 1);
  assert.equal(recovery.retryAttempts, 3);
  assert.equal(recovery.recoveredSuccesses, 2);
  assert.equal(recovery.recoverySuccessRate, 2 / 3);

  const provider = _summarizeProviderQuality([
    { success: true, latencyMs: 100, retryCount: 0, toolErrorCount: 0, modelCost: 0.1 },
    { success: false, latencyMs: 300, retryCount: 2, toolErrorCount: 3, modelCost: 0.2 },
  ]);
  assert.equal(provider.successRate, 0.5);
  assert.equal(provider.averageLatencyMs, 200);
  assert.equal(provider.averageRetryCount, 1);
  assert.equal(provider.toolErrorCount, 3);
  assert.ok(Math.abs(provider.modelCost - 0.3) < 1e-9);
});

test('daily quality evidence requires every UTC date in the observation window', () => {
  const collecting = _buildEvidenceWindow(
    ['2026-07-16', '2026-07-18', '2026-07-19'],
    '2026-07-19',
    4,
  );
  assert.equal(collecting.status, 'collecting');
  assert.equal(collecting.observedDays, 3);
  assert.deepEqual(collecting.missingDates, ['2026-07-17']);
  assert.equal(collecting.oldestEvidenceDate, '2026-07-16');

  const complete = _buildEvidenceWindow(
    ['2026-07-16', '2026-07-17', '2026-07-18', '2026-07-19'],
    '2026-07-19',
    4,
  );
  assert.equal(complete.status, 'complete');
  assert.equal(complete.observedDays, 4);
});

test('daily quality snapshot upsert replaces the same UTC date and preserves one row', async () => {
  const projectId = `daily-quality-${Date.now()}`;
  const first = snapshotInput(projectId, '2026-07-19T08:00:00.000Z', 1);
  const second = snapshotInput(projectId, '2026-07-19T12:00:00.000Z', 3);
  try {
    const inserted = await upsertDailyAgentQualitySnapshot(first);
    const replaced = await upsertDailyAgentQualitySnapshot(second);
    assert.equal(replaced.id, inserted.id);
    assert.equal(replaced.inbox.actionableCount, 3);
    assert.equal(replaced.capturedAt, '2026-07-19T12:00:00.000Z');

    const baseline = await getDailyAgentQualityBaseline({
      projectId,
      requiredDays: 2,
      now: new Date('2026-07-19T13:00:00.000Z'),
    });
    assert.equal(baseline.snapshots.length, 1);
    assert.equal(baseline.evidenceWindow.status, 'collecting');
    assert.deepEqual(baseline.evidenceWindow.missingDates, ['2026-07-18']);
  } finally {
    await getDb().query('DELETE FROM daily_agent_quality_snapshots WHERE project_id=$1', [projectId]);
  }
});

function inbox(
  attentionState: DailyQualityMetricSources['inboxEntries'][number]['attentionState'],
  updatedAt: string,
): DailyQualityMetricSources['inboxEntries'][number] {
  return {
    id: `${attentionState}-${updatedAt}`,
    sourceKind: 'work_item',
    title: attentionState,
    projectId: 'los',
    attentionState,
    nextAction: 'inspect_run',
    updatedAt,
  };
}

function scheduledRun(
  status: DailyQualityMetricSources['scheduleRuns'][number]['status'],
  attemptCount: number,
  scheduledFor: string,
  startedAt?: string,
): DailyQualityMetricSources['scheduleRuns'][number] {
  return {
    id: `${status}-${scheduledFor}`,
    scheduleId: 'schedule-test',
    scheduledFor,
    triggerKind: 'scheduled',
    status,
    attemptCount,
    maxAttempts: 3,
    startedAt,
    createdAt: scheduledFor,
    updatedAt: startedAt ?? scheduledFor,
  };
}

function snapshotInput(
  projectId: string,
  capturedAt: string,
  actionableCount: number,
): Omit<DailyAgentQualitySnapshot, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    tenantId: 'local',
    projectId,
    snapshotDate: '2026-07-19',
    capturedAt,
    windowStart: '2026-07-18T12:00:00.000Z',
    windowEnd: capturedAt,
    inbox: {
      actionableCount, approvalRequired: 0, recoveryRequired: 0,
      verificationBlocked: 0, reviewReady: 0, running: 0, unknown: 0,
      over24h: 0, over72h: 0,
    },
    schedule: {
      runCount: 0, succeeded: 0, noOp: 0, failed: 0, skipped: 0,
      awaitingApproval: 0, other: 0, noOpRate: 0, failureRate: 0,
    },
    recovery: {
      requiredItems: 0, recoveryEvents: 0, retryAttempts: 0,
      recoveredSuccesses: 0, recoverySuccessRate: 0,
    },
    verification: {
      workItems: 0, required: 0, succeeded: 0, skipped: 0,
      failed: 0, pending: 0, missing: 0, coverage: 1,
    },
    providerQuality: {
      evalCount: 0, successCount: 0, failureCount: 0, successRate: 0,
      averageRetryCount: 0, toolErrorCount: 0, modelCost: 0,
    },
  };
}
