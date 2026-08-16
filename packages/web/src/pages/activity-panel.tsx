/**
 * ActivityPanel — multi-agent concurrency timeline (AgentsView Activity
 * benchmark). Per-bucket concurrent session bars with cost, peak/totals, and
 * click-to-drill-down into the sessions active in one bucket.
 *
 * Data: GET /metrics/activity (L1 session_events evidence only).
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity as ActivityIcon, Layers } from 'lucide-react';
import { getJson } from '../api/index.js';
import { useI18n } from '../i18n';

export interface ActivityBucket {
  bucket: string;
  activeSessions: number;
  agentMinutes: number;
  estimatedCostUsd: number;
}

export interface ActivityTotals {
  peakConcurrent: number;
  peakBucket: string | null;
  totalAgentMinutes: number;
  totalCostUsd: number;
  sessionCount: number;
}

export interface ActivityDrilldownSession {
  sessionId: string;
  activeStart: string;
  activeEnd: string;
  eventCount: number;
  estimatedCostUsd: number;
}

export interface MetricsActivityResponse {
  evidenceClass: 'los_runtime';
  from: string;
  to: string;
  bucketSizeMinutes: number;
  buckets: ActivityBucket[];
  totals: ActivityTotals;
  drilldown?: ActivityDrilldownSession[];
}

const WINDOW_HOURS = 24;
const BUCKET_MINUTES = 60;
const CHART_HEIGHT = 120;

export function ActivityPanel() {
  const { t } = useI18n();
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null);

  const from = useMemo(
    () => new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString(),
    [],
  );

  const activity = useQuery({
    queryKey: ['metrics-activity', WINDOW_HOURS],
    queryFn: () => getJson<MetricsActivityResponse>(
      `/metrics/activity?from=${encodeURIComponent(from)}&bucketMinutes=${BUCKET_MINUTES}`,
    ),
    refetchInterval: 60_000,
  });

  const drilldown = useQuery({
    queryKey: ['metrics-activity-drilldown', selectedBucket],
    queryFn: () => getJson<MetricsActivityResponse>(
      `/metrics/activity?from=${encodeURIComponent(from)}&bucketMinutes=${BUCKET_MINUTES}&bucket=${encodeURIComponent(selectedBucket!)}`,
    ),
    enabled: selectedBucket !== null,
  });

  const data = activity.data;
  const maxConcurrent = Math.max(1, ...(data?.buckets.map(b => b.activeSessions) ?? [1]));

  return (
    <section className="activity-panel" aria-label={t('ops.activity.sectionAria')}>
      <div className="activity-head">
        <ActivityIcon size={14} />
        <strong>{t('ops.activity.title')}</strong>
        {data ? (
          <span className="activity-window">
            {t('ops.activity.lastHours', { hours: WINDOW_HOURS })} · {t('ops.activity.bucketSize', { minutes: BUCKET_MINUTES })}
          </span>
        ) : null}
      </div>

      {activity.isLoading ? <p className="timeline-hint">{t('common.loading')}</p> : null}
      {activity.error ? (
        <p className="topology-error" role="alert">{t('ops.activity.loadError', { error: String(activity.error) })}</p>
      ) : null}

      {data && data.buckets.length > 0 ? (
        <>
          <div className="activity-totals">
            <span className="activity-total">
              {t('ops.activity.peak')} <strong>{data.totals.peakConcurrent}</strong>
              {data.totals.peakBucket ? <em>{shortTime(data.totals.peakBucket)}</em> : null}
            </span>
            <span className="activity-total">
              {t('ops.activity.agentMinutes')} <strong>{data.totals.totalAgentMinutes.toLocaleString()}</strong>
            </span>
            <span className="activity-total">
              {t('ops.activity.cost')} <strong>${data.totals.totalCostUsd.toFixed(4)}</strong>
            </span>
            <span className="activity-total">
              {t('ops.activity.sessions')} <strong>{data.totals.sessionCount}</strong>
            </span>
          </div>

          <div className="activity-chart" role="img" aria-label={t('ops.activity.chartAria')}>
            {data.buckets.map(bucket => {
              const height = Math.max(2, (bucket.activeSessions / maxConcurrent) * CHART_HEIGHT);
              const isPeak = data.totals.peakBucket === bucket.bucket;
              const isSelected = selectedBucket === bucket.bucket;
              return (
                <button
                  key={bucket.bucket}
                  type="button"
                  className={`activity-bar${isPeak ? ' is-peak' : ''}${isSelected ? ' is-selected' : ''}${bucket.activeSessions === 0 ? ' is-zero' : ''}`}
                  style={{ height: `${Math.round(height)}px` }}
                  title={`${formatBucketTime(bucket.bucket)} · ${t('ops.activity.concurrent', { n: bucket.activeSessions })} · $${bucket.estimatedCostUsd.toFixed(4)}`}
                  onClick={() => setSelectedBucket(isSelected ? null : bucket.bucket)}
                  aria-label={`${formatBucketTime(bucket.bucket)} ${bucket.activeSessions}`}
                />
              );
            })}
          </div>
          <div className="activity-axis">
            <span>{shortTime(data.buckets[0]!.bucket)}</span>
            <span>{shortTime(data.buckets[data.buckets.length - 1]!.bucket)}</span>
          </div>

          {selectedBucket ? (
            <div className="activity-drilldown">
              <div className="activity-drilldown-head">
                <Layers size={12} />
                <strong>{t('ops.activity.drilldownTitle', { bucket: formatBucketTime(selectedBucket) })}</strong>
              </div>
              {drilldown.isLoading ? <p className="timeline-hint">{t('common.loading')}</p> : null}
              {drilldown.data?.drilldown?.length === 0 ? (
                <p className="timeline-hint">{t('ops.activity.drilldownEmpty')}</p>
              ) : null}
              <ul className="activity-session-list">
                {(drilldown.data?.drilldown ?? []).map(row => (
                  <li key={row.sessionId}>
                    <a href={`#sessions`} onClick={() => selectSession(row.sessionId)}>
                      <code>{row.sessionId}</code>
                    </a>
                    <span>{t('ops.activity.sessionMeta', {
                      events: String(row.eventCount),
                      cost: row.estimatedCostUsd.toFixed(4),
                    })}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : data ? (
        <p className="timeline-hint">{t('ops.activity.empty')}</p>
      ) : null}
    </section>
  );
}

function selectSession(sessionId: string) {
  // Persist target in sessionStorage so the Sessions page can open it on load.
  sessionStorage.setItem('los.activity.session', sessionId);
}

function formatBucketTime(bucket: string): string {
  const date = new Date(bucket);
  return Number.isNaN(date.getTime()) ? bucket : date.toLocaleString();
}

function shortTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
