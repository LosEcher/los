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

const BASELINE_QUERY_KEY = ['daily-agent-quality', 28] as const;

export function DailyQualityView() {
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

  if (baseline.isLoading) return <div className="loading-block">Loading daily quality evidence...</div>;
  if (baseline.error) return <div className="daily-error">Daily quality unavailable: {String(baseline.error)}</div>;
  if (!baseline.data) return null;

  const { evidenceWindow, snapshots } = baseline.data;
  const latest = snapshots[0];

  return (
    <div className="daily-quality" aria-live="polite">
      <section className="quality-evidence-band">
        <div className="quality-evidence-main">
          <CalendarClock size={18} />
          <div>
            <span className="quality-kicker">28-day evidence window</span>
            <strong>{evidenceWindow.observedDays} of {evidenceWindow.requiredDays} UTC days observed</strong>
          </div>
        </div>
        <div className="quality-evidence-range">
          <span>{evidenceWindow.expectedFrom}</span>
          <span aria-hidden="true">to</span>
          <span>{evidenceWindow.expectedTo}</span>
        </div>
        <span className="quality-window-status" data-status={evidenceWindow.status}>{evidenceWindow.status}</span>
        <Button
          variant="ghost"
          onClick={() => capture.mutate()}
          disabled={capture.isPending}
          title="Capture today's quality snapshot"
        >
          <RefreshCw size={14} className={capture.isPending ? 'spin' : ''} />
          {capture.isPending ? 'Capturing...' : 'Capture'}
        </Button>
      </section>

      {capture.error ? <div className="daily-error">Capture failed: {String(capture.error)}</div> : null}

      {!latest ? (
        <div className="daily-empty">
          <CalendarClock size={22} />
          <strong>No quality snapshots</strong>
          <span>Capture the first UTC-day baseline.</span>
        </div>
      ) : (
        <>
          <div className="quality-latest-head">
            <div>
              <span className="quality-kicker">Latest snapshot</span>
              <strong>{latest.snapshotDate}</strong>
            </div>
            <span>Captured {formatDate(latest.capturedAt)}</span>
          </div>

          <div className="quality-metric-groups">
            <MetricGroup title="Inbox" metrics={[
              ['Actionable', count(latest.inbox.actionableCount)],
              ['Approval', count(latest.inbox.approvalRequired)],
              ['Recovery', count(latest.inbox.recoveryRequired)],
              ['Verification blocked', count(latest.inbox.verificationBlocked)],
              ['Review ready', count(latest.inbox.reviewReady)],
              ['Oldest item', duration(latest.inbox.oldestAgeMs)],
              ['Over 24h', count(latest.inbox.over24h)],
              ['Over 72h', count(latest.inbox.over72h)],
            ]} />
            <MetricGroup title="Schedules" metrics={[
              ['Runs', count(latest.schedule.runCount)],
              ['Succeeded', count(latest.schedule.succeeded)],
              ['No-op', count(latest.schedule.noOp)],
              ['Failed', count(latest.schedule.failed)],
              ['Awaiting approval', count(latest.schedule.awaitingApproval)],
              ['No-op rate', percent(latest.schedule.noOpRate)],
              ['Failure rate', percent(latest.schedule.failureRate)],
              ['Avg lateness', duration(latest.schedule.averageLatenessMs)],
            ]} />
            <MetricGroup title="Recovery" metrics={[
              ['Required now', count(latest.recovery.requiredItems)],
              ['Events', count(latest.recovery.recoveryEvents)],
              ['Retry attempts', count(latest.recovery.retryAttempts)],
              ['Recovered', count(latest.recovery.recoveredSuccesses)],
              ['Success rate', percent(latest.recovery.recoverySuccessRate)],
            ]} />
            <MetricGroup title="Verification" metrics={[
              ['Work items', count(latest.verification.workItems)],
              ['Required checks', count(latest.verification.required)],
              ['Succeeded', count(latest.verification.succeeded)],
              ['Skipped', count(latest.verification.skipped)],
              ['Failed', count(latest.verification.failed)],
              ['Pending', count(latest.verification.pending)],
              ['Missing', count(latest.verification.missing)],
              ['Coverage', percent(latest.verification.coverage)],
            ]} />
            <MetricGroup title="Provider / Model Quality" metrics={[
              ['Evals', count(latest.providerQuality.evalCount)],
              ['Successes', count(latest.providerQuality.successCount)],
              ['Failures', count(latest.providerQuality.failureCount)],
              ['Success rate', percent(latest.providerQuality.successRate)],
              ['Avg latency', duration(latest.providerQuality.averageLatencyMs)],
              ['Avg retries', latest.providerQuality.averageRetryCount.toFixed(1)],
              ['Tool errors', count(latest.providerQuality.toolErrorCount)],
              ['Model cost', `$${latest.providerQuality.modelCost.toFixed(4)}`],
            ]} />
          </div>

          <SnapshotHistory snapshots={snapshots} />
        </>
      )}

      {evidenceWindow.missingDates.length > 0 ? (
        <details className="quality-missing-dates">
          <summary>{evidenceWindow.missingDates.length} missing UTC dates</summary>
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
  return (
    <section className="quality-history">
      <h3>Recent snapshots</h3>
      <div className="quality-table-wrap">
        <table className="quality-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Inbox</th>
              <th>Schedule fail</th>
              <th>Recovery</th>
              <th>Verification</th>
              <th>Provider success</th>
              <th>Captured</th>
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

function duration(value: number | undefined): string {
  if (value === undefined) return 'n/a';
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)}s`;
  if (value < 3_600_000) return `${Math.round(value / 60_000)}m`;
  return `${(value / 3_600_000).toFixed(1)}h`;
}
