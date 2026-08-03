import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, RefreshCw } from 'lucide-react';

import {
  getJson,
  postJson,
  type DailyAgentQualityBaseline,
  type DailyAgentQualityCaptureResponse,
  type DailyAgentQualitySnapshot,
} from '../api/index.js';
import { Button, formatDate } from '../ui.js';
import { useI18n } from '../i18n';

const BASELINE_QUERY_KEY = ['daily-agent-quality', 28] as const;

export function DailyQualityView() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const baseline = useQuery({
    queryKey: BASELINE_QUERY_KEY,
    queryFn: () => getJson<DailyAgentQualityBaseline>('/daily-agent-quality/baseline?days=28'),
    refetchInterval: 60_000,
  });
  const capture = useMutation({
    mutationFn: () => postJson<DailyAgentQualityCaptureResponse>('/daily-agent-quality/capture', {}),
    onSuccess: result => {
      queryClient.setQueryData<DailyAgentQualityBaseline>(BASELINE_QUERY_KEY, current => ({
        evidenceWindow: result.evidenceWindow,
        snapshots: [
          result.snapshot,
          ...(current?.snapshots ?? []).filter(snapshot => snapshot.snapshotDate !== result.snapshot.snapshotDate),
        ],
      }));
    },
  });

  if (baseline.isLoading) return <div className="loading-block">{t('ops.dailyQuality.loading')}</div>;
  if (baseline.error) return <div className="daily-error">{t('ops.dailyQuality.unavailablePrefix', { error: String(baseline.error) })}</div>;
  if (!baseline.data) return null;

  const { evidenceWindow, snapshots } = baseline.data;
  const latest = snapshots[0];

  return (
    <div className="daily-quality" aria-live="polite">
      <section className="quality-evidence-band">
        <div className="quality-evidence-main">
          <CalendarClock size={18} />
          <div>
            <span className="quality-kicker">{t('ops.dailyQuality.evidenceWindowLabel')}</span>
            <strong>{t('ops.dailyQuality.daysObserved', { observed: evidenceWindow.observedDays, required: evidenceWindow.requiredDays })}</strong>
          </div>
        </div>
        <div className="quality-evidence-range">
          <span>{evidenceWindow.expectedFrom}</span>
          <span aria-hidden="true">{t('ops.dailyQuality.toLabel')}</span>
          <span>{evidenceWindow.expectedTo}</span>
        </div>
        <span className="quality-window-status" data-status={evidenceWindow.status}>{evidenceWindow.status}</span>
        <Button
          variant="ghost"
          onClick={() => capture.mutate()}
          disabled={capture.isPending}
          title={t('ops.dailyQuality.captureTitle')}
        >
          <RefreshCw size={14} className={capture.isPending ? 'spin' : ''} />
          {capture.isPending ? t('ops.dailyQuality.capturing') : t('ops.dailyQuality.captureButton')}
        </Button>
      </section>

      {capture.error ? <div className="daily-error">{t('ops.dailyQuality.captureFailedPrefix', { error: String(capture.error) })}</div> : null}

      {!latest ? (
        <div className="daily-empty">
          <CalendarClock size={22} />
          <strong>{t('ops.dailyQuality.noSnapshots')}</strong>
          <span>{t('ops.dailyQuality.captureFirstHint')}</span>
        </div>
      ) : (
        <>
          <div className="quality-latest-head">
            <div>
              <span className="quality-kicker">{t('ops.dailyQuality.latestSnapshotLabel')}</span>
              <strong>{latest.snapshotDate}</strong>
            </div>
            <span>{t('ops.dailyQuality.capturedAtLabel', { date: formatDate(latest.capturedAt) })}</span>
          </div>

          <div className="quality-metric-groups">
            <MetricGroup title={t('ops.dailyQuality.groupInbox')} metrics={[
              [t('ops.dailyQuality.inboxActionable'), count(latest.inbox.actionableCount)],
              [t('ops.dailyQuality.inboxApproval'), count(latest.inbox.approvalRequired)],
              [t('ops.dailyQuality.inboxRecovery'), count(latest.inbox.recoveryRequired)],
              [t('ops.dailyQuality.inboxVerificationBlocked'), count(latest.inbox.verificationBlocked)],
              [t('ops.dailyQuality.inboxReviewReady'), count(latest.inbox.reviewReady)],
              [t('ops.dailyQuality.inboxOldestItem'), duration(latest.inbox.oldestAgeMs, t)],
              [t('ops.dailyQuality.inboxOver24h'), count(latest.inbox.over24h)],
              [t('ops.dailyQuality.inboxOver72h'), count(latest.inbox.over72h)],
            ]} />
            <MetricGroup title={t('ops.dailyQuality.groupSchedules')} metrics={[
              [t('ops.dailyQuality.schedRuns'), count(latest.schedule.runCount)],
              [t('ops.dailyQuality.schedSucceeded'), count(latest.schedule.succeeded)],
              [t('ops.dailyQuality.schedNoOp'), count(latest.schedule.noOp)],
              [t('ops.dailyQuality.schedFailed'), count(latest.schedule.failed)],
              [t('ops.dailyQuality.schedAwaitingApproval'), count(latest.schedule.awaitingApproval)],
              [t('ops.dailyQuality.schedNoOpRate'), percent(latest.schedule.noOpRate)],
              [t('ops.dailyQuality.schedFailureRate'), percent(latest.schedule.failureRate)],
              [t('ops.dailyQuality.schedAvgLateness'), duration(latest.schedule.averageLatenessMs, t)],
            ]} />
            <MetricGroup title={t('ops.dailyQuality.groupRecovery')} metrics={[
              [t('ops.dailyQuality.recoveryRequiredNow'), count(latest.recovery.requiredItems)],
              [t('ops.dailyQuality.recoveryEvents'), count(latest.recovery.recoveryEvents)],
              [t('ops.dailyQuality.recoveryRetryAttempts'), count(latest.recovery.retryAttempts)],
              [t('ops.dailyQuality.recoveryRecovered'), count(latest.recovery.recoveredSuccesses)],
              [t('ops.dailyQuality.recoverySuccessRate'), percent(latest.recovery.recoverySuccessRate)],
            ]} />
            <MetricGroup title={t('ops.dailyQuality.groupVerification')} metrics={[
              [t('ops.dailyQuality.verifWorkItems'), count(latest.verification.workItems)],
              [t('ops.dailyQuality.verifRequiredChecks'), count(latest.verification.required)],
              [t('ops.dailyQuality.verifSucceeded'), count(latest.verification.succeeded)],
              [t('ops.dailyQuality.verifSkipped'), count(latest.verification.skipped)],
              [t('ops.dailyQuality.verifFailed'), count(latest.verification.failed)],
              [t('ops.dailyQuality.verifPending'), count(latest.verification.pending)],
              [t('ops.dailyQuality.verifMissing'), count(latest.verification.missing)],
              [t('ops.dailyQuality.verifCoverage'), percent(latest.verification.coverage)],
            ]} />
            <MetricGroup title={t('ops.dailyQuality.groupProviderModel')} metrics={[
              [t('ops.dailyQuality.provEvals'), count(latest.providerQuality.evalCount)],
              [t('ops.dailyQuality.provSuccesses'), count(latest.providerQuality.successCount)],
              [t('ops.dailyQuality.provFailures'), count(latest.providerQuality.failureCount)],
              [t('ops.dailyQuality.provSuccessRate'), percent(latest.providerQuality.successRate)],
              [t('ops.dailyQuality.provAvgLatency'), duration(latest.providerQuality.averageLatencyMs, t)],
              [t('ops.dailyQuality.provAvgRetries'), latest.providerQuality.averageRetryCount.toFixed(1)],
              [t('ops.dailyQuality.provToolErrors'), count(latest.providerQuality.toolErrorCount)],
              [t('ops.dailyQuality.provModelCost'), `$${latest.providerQuality.modelCost.toFixed(4)}`],
            ]} />
          </div>

          <SnapshotHistory snapshots={snapshots} />
        </>
      )}

      {evidenceWindow.missingDates.length > 0 ? (
        <details className="quality-missing-dates">
          <summary>{t('ops.dailyQuality.missingDatesLabel', { count: evidenceWindow.missingDates.length })}</summary>
          <div>{evidenceWindow.missingDates.join(', ')}</div>
        </details>
      ) : null}
    </div>
  );
}

function MetricGroup({ title, metrics }: { title: string; metrics: Array<[string, string]> }) {
  return (
    <section className="quality-metric-group">
      <h3>{title}</h3>
      <dl>
        {metrics.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function SnapshotHistory({ snapshots }: { snapshots: DailyAgentQualitySnapshot[] }) {
  const { t } = useI18n();
  return (
    <section className="quality-history">
      <h3>{t('ops.dailyQuality.recentSnapshotsTitle')}</h3>
      <div className="quality-table-wrap">
        <table className="quality-table">
          <thead>
            <tr>
              <th>{t('ops.dailyQuality.thDate')}</th>
              <th>{t('ops.dailyQuality.groupInbox')}</th>
              <th>{t('ops.dailyQuality.thScheduleFail')}</th>
              <th>{t('ops.dailyQuality.groupRecovery')}</th>
              <th>{t('ops.dailyQuality.groupVerification')}</th>
              <th>{t('ops.dailyQuality.thProviderSuccess')}</th>
              <th>{t('ops.dailyQuality.thCaptured')}</th>
            </tr>
          </thead>
          <tbody>
            {snapshots.slice(0, 28).map(snapshot => (
              <tr key={snapshot.id}>
                <td><strong>{snapshot.snapshotDate}</strong></td>
                <td>{snapshot.inbox.actionableCount}</td>
                <td>{percent(snapshot.schedule.failureRate)}</td>
                <td>{snapshot.recovery.requiredItems}</td>
                <td>{percent(snapshot.verification.coverage)}</td>
                <td>{percent(snapshot.providerQuality.successRate)}</td>
                <td>{formatDate(snapshot.capturedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function count(value: number): string {
  return value.toLocaleString();
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function duration(value: number | undefined, t: (key: string) => string): string {
  if (value === undefined) return t('ops.na');
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)}s`;
  if (value < 3_600_000) return `${Math.round(value / 60_000)}m`;
  return `${(value / 3_600_000).toFixed(1)}h`;
}
