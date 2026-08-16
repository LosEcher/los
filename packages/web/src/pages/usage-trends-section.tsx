/**
 * UsageTrendsSection — provider/model latency series with window compare.
 *
 * Phase 3 fleet trend view. Consumes GET /metrics/trends: per-day p50/p95
 * latency, error rate, calls, and a compare block (current vs previous window
 * deltas). Sparklines are self-drawn SVG (no new deps).
 */
import { ArrowDownRight, ArrowUpRight, Minus, TrendingUp } from 'lucide-react';
import { useI18n } from '../i18n';
import { Sparkline } from './sparkline.js';

export interface TrendPoint {
  day: string;
  callCount: number;
  errorCount: number;
  errorRate: number;
  avgDurationMs: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  usageFillRate: number | null;
}

export interface TrendCompare {
  currentCalls: number;
  previousCalls: number;
  callsDeltaPct: number | null;
  currentErrorRate: number;
  previousErrorRate: number;
  errorRateDeltaPct: number | null;
  currentAvgMs: number | null;
  previousAvgMs: number | null;
  avgMsDeltaPct: number | null;
}

export interface ProviderTrend {
  provider: string;
  model: string;
  points: TrendPoint[];
  compare: TrendCompare;
}

export interface MetricsTrendsResponse {
  evidenceClass: 'los_runtime';
  from: string;
  to: string;
  series: ProviderTrend[];
}

/** Arrow + colored delta; green when the delta is an improvement (↓ latency/errors, ↑ calls). */
function Delta({
  value,
  invert,
}: {
  value: number | null;
  /** true when a positive delta is good (e.g. calls). */
  invert: boolean;
}) {
  const { t } = useI18n();
  if (value === null || !Number.isFinite(value)) {
    return <span className="trend-delta is-flat" title={t('ops.usage.trendVsPrevious')}><Minus size={11} />—</span>;
  }
  const pct = Math.abs(value * 100) >= 100 ? value * 100 : Math.round(value * 1000) / 10;
  const up = value > 0;
  const good = invert ? up : !up;
  return (
    <span
      className={`trend-delta ${good ? 'is-good' : 'is-bad'}`}
      title={t('ops.usage.trendVsPrevious')}
    >
      {up ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
      {`${Math.abs(pct) >= 100 ? Math.round(pct) : pct}%`}
    </span>
  );
}

export function UsageTrendsSection({ data }: { data: MetricsTrendsResponse | undefined }) {
  const { t } = useI18n();

  if (!data) return null;

  return (
    <section className="usage-table-section">
      <h3><TrendingUp size={14} /> {t('ops.usage.trendsTitle')}</h3>
      <p className="usage-note">{t('ops.usage.trendsNote')}</p>
      {data.series.length === 0 ? (
        <div className="daily-empty"><span>{t('ops.usage.trendEmpty')}</span></div>
      ) : (
        <div className="trend-grid">
          {data.series.map(trend => (
            <article key={`${trend.provider}:${trend.model}`} className="trend-card">
              <div className="trend-card-head">
                <strong>{trend.provider}</strong>
                <code>{trend.model}</code>
              </div>
              <Sparkline
                values={trend.points.map(point => point.p50DurationMs)}
                title={t('ops.usage.trendLatencySpark', { provider: trend.provider, model: trend.model })}
              />
              <dl className="trend-card-deltas">
                <div className="trend-delta-row">
                  <dt>{t('ops.usage.trendCalls')}</dt>
                  <dd>
                    {trend.compare.currentCalls}
                    <Delta value={trend.compare.callsDeltaPct} invert />
                  </dd>
                </div>
                <div className="trend-delta-row">
                  <dt>{t('ops.usage.trendErrorRate')}</dt>
                  <dd>
                    {pct(trend.compare.currentErrorRate)}
                    <Delta value={trend.compare.errorRateDeltaPct} invert={false} />
                  </dd>
                </div>
                <div className="trend-delta-row">
                  <dt>{t('ops.usage.trendAvgMs')}</dt>
                  <dd>
                    {trend.compare.currentAvgMs === null ? '—' : Math.round(trend.compare.currentAvgMs)}
                    <Delta value={trend.compare.avgMsDeltaPct} invert={false} />
                  </dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}
