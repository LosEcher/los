import type {
  DailyAgentQualityEvidenceWindow,
  DailyAgentQualityInboxMetrics,
  DailyAgentQualityProviderMetrics,
  DailyAgentQualityRecoveryMetrics,
  DailyAgentQualityScheduleMetrics,
  DailyAgentQualityVerificationMetrics,
  DailyQualityMetricSources,
} from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function _summarizeInbox(
  entries: DailyQualityMetricSources['inboxEntries'],
  capturedAt: Date,
): DailyAgentQualityInboxMetrics {
  const ages = entries.map(entry => Math.max(0, capturedAt.getTime() - new Date(entry.updatedAt).getTime()));
  return {
    actionableCount: entries.length,
    approvalRequired: count(entries, 'approval_required'),
    recoveryRequired: count(entries, 'recovery_required'),
    verificationBlocked: count(entries, 'verification_blocked'),
    reviewReady: count(entries, 'review_ready'),
    running: count(entries, 'running'),
    unknown: count(entries, 'unknown'),
    oldestAgeMs: ages.length > 0 ? Math.max(...ages) : undefined,
    over24h: ages.filter(age => age > DAY_MS).length,
    over72h: ages.filter(age => age > 3 * DAY_MS).length,
  };
}

export function _summarizeSchedule(
  runs: DailyQualityMetricSources['scheduleRuns'],
): DailyAgentQualityScheduleMetrics {
  const lateness = runs
    .filter(run => Boolean(run.startedAt))
    .map(run => Math.max(0, new Date(run.startedAt!).getTime() - new Date(run.scheduledFor).getTime()));
  const runCount = runs.length;
  const noOp = runs.filter(run => run.status === 'no_op').length;
  const failed = runs.filter(run => run.status === 'failed').length;
  const known = new Set(['succeeded', 'no_op', 'failed', 'skipped', 'awaiting_approval']);
  return {
    runCount,
    succeeded: runs.filter(run => run.status === 'succeeded').length,
    noOp,
    failed,
    skipped: runs.filter(run => run.status === 'skipped').length,
    awaitingApproval: runs.filter(run => run.status === 'awaiting_approval').length,
    other: runs.filter(run => !known.has(run.status)).length,
    noOpRate: runCount > 0 ? noOp / runCount : 0,
    failureRate: runCount > 0 ? failed / runCount : 0,
    averageLatenessMs: lateness.length > 0 ? mean(lateness) : undefined,
    maxLatenessMs: lateness.length > 0 ? Math.max(...lateness) : undefined,
  };
}

export function _summarizeRecovery(
  sources: Pick<DailyQualityMetricSources, 'inboxEntries' | 'scheduleRuns' | 'taskRetries' | 'recoveryEvents'>,
): DailyAgentQualityRecoveryMetrics {
  const retried = [
    ...sources.taskRetries,
    ...sources.scheduleRuns.map(run => ({ attempt: run.attemptCount, status: run.status })),
  ].filter(run => run.attempt > 1);
  const retryAttempts = retried.reduce((total, run) => total + run.attempt - 1, 0);
  const recoveredSuccesses = retried.filter(run => run.status === 'succeeded' || run.status === 'no_op').length;
  return {
    requiredItems: sources.inboxEntries.filter(entry => entry.attentionState === 'recovery_required').length,
    recoveryEvents: sources.recoveryEvents,
    retryAttempts,
    recoveredSuccesses,
    recoverySuccessRate: retryAttempts > 0 ? recoveredSuccesses / retryAttempts : 0,
  };
}

export function _summarizeVerification(
  coverage: DailyQualityMetricSources['verification'],
): DailyAgentQualityVerificationMetrics {
  return {
    workItems: coverage.workItems,
    required: coverage.required,
    succeeded: coverage.succeeded,
    skipped: coverage.skipped,
    failed: coverage.failed,
    pending: coverage.pending,
    missing: coverage.missing,
    coverage: coverage.coverage,
  };
}

export function _summarizeProviderQuality(
  evals: DailyQualityMetricSources['providerEvals'],
): DailyAgentQualityProviderMetrics {
  const successCount = evals.filter(item => item.success).length;
  const latencies = evals.flatMap(item => item.latencyMs === undefined ? [] : [item.latencyMs]);
  return {
    evalCount: evals.length,
    successCount,
    failureCount: evals.length - successCount,
    successRate: evals.length > 0 ? successCount / evals.length : 0,
    averageLatencyMs: latencies.length > 0 ? mean(latencies) : undefined,
    averageRetryCount: evals.length > 0 ? mean(evals.map(item => item.retryCount)) : 0,
    toolErrorCount: evals.reduce((total, item) => total + item.toolErrorCount, 0),
    modelCost: evals.reduce((total, item) => total + (item.modelCost ?? 0), 0),
  };
}

export function _buildEvidenceWindow(
  snapshotDates: string[],
  expectedTo: string,
  requiredDays: number,
): DailyAgentQualityEvidenceWindow {
  const normalizedDays = Math.min(90, Math.max(1, Math.floor(requiredDays)));
  const expected = dateSequenceEndingAt(expectedTo, normalizedDays);
  const observed = new Set(snapshotDates);
  const missingDates = expected.filter(date => !observed.has(date));
  const sortedEvidence = [...observed].sort();
  return {
    status: missingDates.length === 0 ? 'complete' : 'collecting',
    observedDays: expected.length - missingDates.length,
    requiredDays: normalizedDays,
    expectedFrom: expected[0]!,
    expectedTo: expected.at(-1)!,
    oldestEvidenceDate: sortedEvidence[0],
    newestEvidenceDate: sortedEvidence.at(-1),
    missingDates,
  };
}

function count(entries: DailyQualityMetricSources['inboxEntries'], state: string): number {
  return entries.filter(entry => entry.attentionState === state).length;
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function dateSequenceEndingAt(isoDate: string, days: number): string[] {
  const end = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(end.getTime())) throw new Error('expectedTo must be a UTC date');
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(end.getTime() - (days - index - 1) * DAY_MS);
    return date.toISOString().slice(0, 10);
  });
}
