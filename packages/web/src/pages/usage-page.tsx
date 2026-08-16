import { useQuery } from '@tanstack/react-query';
import { CircleDollarSign, RefreshCw } from 'lucide-react';

import { getJson } from '../api/index.js';
import { FleetCard } from '../fleet-card.js';
import { Button } from '../ui.js';
import { useI18n } from '../i18n';
import { Sparkline } from './sparkline.js';
import { UsageTrendsSection, type MetricsTrendsResponse } from './usage-trends-section.js';

export type UsageSummaryResponse = {
  evidenceClass: 'los_runtime';
  from: string;
  to: string;
  totals: {
    modelResponseCount: number;
    sessionCount: number;
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    cacheSavingsUsd: number;
    cacheHitRate: number | null;
  };
  byProviderModel: Array<{
    provider: string;
    model: string;
    modelResponseCount: number;
    sessionCount: number;
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    estimatedCostUsd: number;
    cacheSavingsUsd: number;
  }>;
  byDay: Array<{
    day: string;
    modelResponseCount: number;
    sessionCount: number;
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens: number;
    estimatedCostUsd: number;
  }>;
  callTelemetry: Array<{
    provider: string;
    model: string;
    callCount: number;
    errorCount: number;
    avgDurationMs: number | null;
    withUsageCount: number;
    usageFillRate: number | null;
  }>;
};

const DAYS = 7;

type DailyDigestResponse = {
  day: string;
  highlights: string[];
  schedule: {
    enabledCount: number;
    runTotals: {
      runCount: number;
      succeeded: number;
      failed: number;
      cancelled: number;
    };
  };
  cadenceRecommendations: Array<{
    scheduleId: string;
    title: string;
    severity: string;
    action: string;
    currentExpression: string;
    recommendedExpression?: string;
    rationale: string;
  }>;
};

export function UsagePage({ day }: { day?: string | null } = {}) {
  const { t } = useI18n();
  const digestDay = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined;
  const from = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();
  const query = useQuery({
    queryKey: ['usage-summary', DAYS],
    queryFn: () => getJson<UsageSummaryResponse>(`/usage/summary?from=${encodeURIComponent(from)}`),
    refetchInterval: 60_000,
  });
  const digest = useQuery({
    queryKey: ['daily-digest', digestDay ?? 'default'],
    queryFn: () => getJson<DailyDigestResponse>(
      digestDay
        ? `/ops/daily-digest?day=${encodeURIComponent(digestDay)}`
        : '/ops/daily-digest',
    ),
    refetchInterval: 120_000,
  });
  const trendsFrom = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const trends = useQuery({
    queryKey: ['metrics-trends', 14],
    queryFn: () => getJson<MetricsTrendsResponse>(
      `/metrics/trends?from=${encodeURIComponent(trendsFrom)}`,
    ),
    refetchInterval: 120_000,
  });

  if (query.isLoading) return <div className="loading-block">{t('ops.usage.loading')}</div>;
  if (query.error) {
    return <div className="daily-error">{t('ops.usage.unavailablePrefix', { error: String(query.error) })}</div>;
  }
  if (!query.data) return null;

  const { totals, byProviderModel, byDay, callTelemetry, evidenceClass } = query.data;

  return (
    <div className="daily-quality usage-page" aria-live="polite">
      <section className="quality-evidence-band">
        <div className="quality-evidence-main">
          <CircleDollarSign size={18} />
          <div>
            <span className="quality-kicker">{t('ops.usage.evidenceClassLabel')}</span>
            <strong>{evidenceClass}</strong>
          </div>
        </div>
        <div className="quality-evidence-range">
          <span>{t('ops.usage.lastDays', { days: DAYS })}</span>
        </div>
        <Button
          variant="ghost"
          onClick={() => { void query.refetch(); void digest.refetch(); }}
          disabled={query.isFetching || digest.isFetching}
          title={t('ops.usage.refreshTitle')}
        >
          <RefreshCw size={14} className={query.isFetching || digest.isFetching ? 'spin' : ''} />
          {t('ops.usage.refresh')}
        </Button>
      </section>

      <p className="usage-note">{t('ops.usage.l1Note')}</p>

      <FleetCard compact />

      {digest.data ? (
        <section className="usage-table-section">
          <h3>{t('ops.usage.digestTitle', { day: digest.data.day })}</h3>
          <ul className="usage-note">
            {digest.data.highlights.map(line => <li key={line}>{line}</li>)}
          </ul>
          <div className="quality-metric-groups">
            <MetricGroup title={t('ops.usage.digestSchedule')} metrics={[
              [t('ops.usage.digestEnabled'), count(digest.data.schedule.enabledCount)],
              [t('ops.usage.digestRuns'), count(digest.data.schedule.runTotals.runCount)],
              [t('ops.usage.digestOk'), count(digest.data.schedule.runTotals.succeeded)],
              [t('ops.usage.digestFail'), count(digest.data.schedule.runTotals.failed)],
              [t('ops.usage.digestCancel'), count(digest.data.schedule.runTotals.cancelled)],
            ]} />
          </div>
          {digest.data.cadenceRecommendations.length > 0 ? (
            <table className="usage-table">
              <thead>
                <tr>
                  <th>{t('ops.usage.colSeverity')}</th>
                  <th>{t('ops.usage.colAction')}</th>
                  <th>{t('ops.usage.colSchedule')}</th>
                  <th>{t('ops.usage.colCadence')}</th>
                  <th>{t('ops.usage.colRationale')}</th>
                </tr>
              </thead>
              <tbody>
                {digest.data.cadenceRecommendations.map(row => (
                  <tr key={`${row.scheduleId}:${row.action}`}>
                    <td>{row.severity}</td>
                    <td>{row.action}</td>
                    <td>{row.title}</td>
                    <td>{row.recommendedExpression ? `${row.currentExpression} → ${row.recommendedExpression}` : row.currentExpression}</td>
                    <td>{row.rationale}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      ) : null}

      <div className="quality-metric-groups">
        <MetricGroup title={t('ops.usage.groupTotals')} metrics={[
          [t('ops.usage.metricResponses'), count(totals.modelResponseCount)],
          [t('ops.usage.metricSessions'), count(totals.sessionCount)],
          [t('ops.usage.metricPromptTokens'), count(totals.promptTokens)],
          [t('ops.usage.metricCompletionTokens'), count(totals.completionTokens)],
          [t('ops.usage.metricCacheHit'), count(totals.cacheHitTokens)],
          [t('ops.usage.metricCacheMiss'), count(totals.cacheMissTokens)],
          [t('ops.usage.metricCacheHitRate'), percent(totals.cacheHitRate)],
          [t('ops.usage.metricCost'), money(totals.estimatedCostUsd)],
          [t('ops.usage.metricCacheSavings'), money(totals.cacheSavingsUsd)],
        ]} />
      </div>

      <section className="usage-table-section">
        <h3>{t('ops.usage.byProviderModel')}</h3>
        {byProviderModel.length === 0 ? (
          <div className="daily-empty"><span>{t('ops.usage.empty')}</span></div>
        ) : (
          <table className="usage-table">
            <thead>
              <tr>
                <th>{t('ops.usage.colProvider')}</th>
                <th>{t('ops.usage.colModel')}</th>
                <th>{t('ops.usage.colResponses')}</th>
                <th>{t('ops.usage.colCost')}</th>
                <th>{t('ops.usage.colPrompt')}</th>
                <th>{t('ops.usage.colCompletion')}</th>
                <th>{t('ops.usage.colCacheHit')}</th>
              </tr>
            </thead>
            <tbody>
              {byProviderModel.map(row => (
                <tr key={`${row.provider}:${row.model}`}>
                  <td>{row.provider}</td>
                  <td>{row.model}</td>
                  <td>{count(row.modelResponseCount)}</td>
                  <td>{money(row.estimatedCostUsd)}</td>
                  <td>{count(row.promptTokens)}</td>
                  <td>{count(row.completionTokens)}</td>
                  <td>{count(row.cacheHitTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="usage-table-section">
        <h3>{t('ops.usage.byDay')}</h3>
        {byDay.length === 0 ? (
          <div className="daily-empty"><span>{t('ops.usage.empty')}</span></div>
        ) : (
          <table className="usage-table">
            <thead>
              <tr>
                <th>{t('ops.usage.colDay')}</th>
                <th>{t('ops.usage.colResponses')}</th>
                <th>{t('ops.usage.colSessions')}</th>
                <th>{t('ops.usage.colCost')}</th>
                <th>{t('ops.usage.colPrompt')}</th>
                <th>{t('ops.usage.colCompletion')}</th>
              </tr>
            </thead>
            <tbody>
              {byDay.map(row => (
                <tr key={row.day}>
                  <td>{row.day}</td>
                  <td>{count(row.modelResponseCount)}</td>
                  <td>{count(row.sessionCount)}</td>
                  <td>{money(row.estimatedCostUsd)}</td>
                  <td>{count(row.promptTokens)}</td>
                  <td>{count(row.completionTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="usage-table-section">
        <h3>{t('ops.usage.callTelemetry')}</h3>
        <p className="usage-note">{t('ops.usage.callTelemetryNote')}</p>
        {callTelemetry.length === 0 ? (
          <div className="daily-empty"><span>{t('ops.usage.empty')}</span></div>
        ) : (
          <table className="usage-table">
            <thead>
              <tr>
                <th>{t('ops.usage.colProvider')}</th>
                <th>{t('ops.usage.colModel')}</th>
                <th>{t('ops.usage.colCalls')}</th>
                <th>{t('ops.usage.colErrors')}</th>
                <th>{t('ops.usage.colAvgMs')}</th>
                <th>{t('ops.usage.colUsageFill')}</th>
                <th>{t('ops.usage.colLatencyTrend')}</th>
              </tr>
            </thead>
            <tbody>
              {callTelemetry.map(row => (
                <tr key={`call:${row.provider}:${row.model}`}>
                  <td>{row.provider}</td>
                  <td>{row.model}</td>
                  <td>{count(row.callCount)}</td>
                  <td>{count(row.errorCount)}</td>
                  <td>{row.avgDurationMs == null ? '—' : Math.round(row.avgDurationMs)}</td>
                  <td>{percent(row.usageFillRate)}</td>
                  <td>
                    <Sparkline
                      values={trendP50Series(trends.data, row.provider, row.model)}
                      title={t('ops.usage.trendLatencySpark', { provider: row.provider, model: row.model })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <UsageTrendsSection data={trends.data} />
    </div>
  );
}

/** Match per-day p50 latency series from /metrics/trends for one provider/model. */
export function trendP50Series(
  trends: MetricsTrendsResponse | undefined,
  provider: string,
  model: string,
): Array<number | null> {
  if (!trends) return [];
  const trend = trends.series.find(row => row.provider === provider && row.model === model);
  return trend ? trend.points.map(point => point.p50DurationMs) : [];
}

function MetricGroup({ title, metrics }: { title: string; metrics: Array<[string, string]> }) {
  return (
    <div className="quality-metric-group">
      <h3>{title}</h3>
      <dl>
        {metrics.map(([label, value]) => (
          <div key={label} className="quality-metric-row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function count(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString() : '0';
}

function money(n: number): string {
  return `$${(Number.isFinite(n) ? n : 0).toFixed(4)}`;
}

function percent(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}
