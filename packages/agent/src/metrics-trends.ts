/**
 * Provider call trends — per-day latency/error series with window compare.
 *
 * Aggregates provider_call_telemetry only (L1 los runtime evidence). Supplies
 * the Phase 3 fleet trend view: daily P50/P95 latency, error rate, call count,
 * usage fill rate per provider x model, plus a compare block measuring the
 * current window against the preceding window of equal length.
 */

import { getDb } from '@los/infra/db';

export interface TrendsQuery {
  /** Inclusive lower bound ISO timestamp. Default: now - 14 days. */
  from?: string;
  /** Exclusive upper bound ISO timestamp. Default: now. */
  to?: string;
  /** Optional provider filter (exact). */
  provider?: string;
  /** Optional model filter (exact). */
  model?: string;
}

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
  /** (current - previous) / previous; null when previous window had no calls. */
  callsDeltaPct: number | null;
  currentErrorRate: number;
  previousErrorRate: number;
  errorRateDeltaPct: number | null;
  currentAvgMs: number | null;
  previousAvgMs: number | null;
  /** Relative avg latency change; null when either window lacks calls. */
  avgMsDeltaPct: number | null;
}

export interface ProviderTrend {
  provider: string;
  model: string;
  points: TrendPoint[];
  compare: TrendCompare;
}

export interface MetricsTrends {
  evidenceClass: 'los_runtime';
  from: string;
  to: string;
  series: ProviderTrend[];
}

const DEFAULT_WINDOW_DAYS = 14;
const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

interface SeriesRow {
  provider: string;
  model: string;
  day: string;
  call_count: string;
  error_count: string;
  avg_ms: string | null;
  p50_ms: string | null;
  p95_ms: string | null;
  usage_fill_rate: string | null;
}

interface WindowRow {
  provider: string;
  model: string;
  call_count: string;
  error_count: string;
  avg_ms: string | null;
}

function resolveWindow(query: TrendsQuery): { from: string; to: string; prevFrom: string; prevTo: string } {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error('metrics trends requires valid from/to ISO timestamps');
  }
  if (from.getTime() >= to.getTime()) {
    throw new Error('metrics trends requires from < to');
  }
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) {
    throw new Error('metrics trends window must be <= 90 days');
  }
  const spanMs = to.getTime() - from.getTime();
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    prevFrom: new Date(from.getTime() - spanMs).toISOString(),
    prevTo: from.toISOString(),
  };
}

function num(value: string | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function nullableNum(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function deltaPct(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return (current - previous) / previous;
}

export async function getMetricsTrends(query: TrendsQuery = {}): Promise<MetricsTrends> {
  const window = resolveWindow(query);
  const db = getDb();

  const filters: string[] = [];
  const params: unknown[] = [window.from, window.to];
  let index = 3;
  if (query.provider) {
    filters.push(`AND provider = $${index++}`);
    params.push(query.provider);
  }
  if (query.model) {
    filters.push(`AND model = $${index++}`);
    params.push(query.model);
  }
  const filterSql = filters.join(' ');

  const series = await db.query<SeriesRow>(
    `SELECT
        provider,
        model,
        to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
        COUNT(*)::text AS call_count,
        SUM(CASE WHEN status >= 400 OR status = 0 THEN 1 ELSE 0 END)::text AS error_count,
        AVG(duration_ms)::text AS avg_ms,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::text AS p50_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::text AS p95_ms,
        (SUM(CASE WHEN usage_json IS NOT NULL AND usage_json::text NOT IN ('{}', 'null') THEN 1 ELSE 0 END)::float8
           / NULLIF(COUNT(*), 0))::text AS usage_fill_rate
      FROM provider_call_telemetry
      WHERE created_at >= $1::timestamptz
        AND created_at < $2::timestamptz
        ${filterSql}
      GROUP BY provider, model, 3
      ORDER BY provider, model, day ASC`,
    params,
  );

  const prevParams = [window.prevFrom, window.prevTo, ...params.slice(2)];
  const previous = await db.query<WindowRow>(
    `SELECT
        provider,
        model,
        COUNT(*)::text AS call_count,
        SUM(CASE WHEN status >= 400 OR status = 0 THEN 1 ELSE 0 END)::text AS error_count,
        AVG(duration_ms)::text AS avg_ms
      FROM provider_call_telemetry
      WHERE created_at >= $1::timestamptz
        AND created_at < $2::timestamptz
        ${filterSql}
      GROUP BY provider, model
      ORDER BY provider, model`,
    prevParams,
  );

  const byKey = new Map<string, ProviderTrend>();
  for (const row of series.rows) {
    const key = `${row.provider}\u0000${row.model}`;
    let trend = byKey.get(key);
    if (!trend) {
      trend = { provider: row.provider, model: row.model, points: [], compare: emptyCompare() };
      byKey.set(key, trend);
    }
    const callCount = num(row.call_count);
    const errorCount = num(row.error_count);
    trend.points.push({
      day: row.day,
      callCount,
      errorCount,
      errorRate: callCount > 0 ? errorCount / callCount : 0,
      avgDurationMs: nullableNum(row.avg_ms),
      p50DurationMs: nullableNum(row.p50_ms),
      p95DurationMs: nullableNum(row.p95_ms),
      usageFillRate: nullableNum(row.usage_fill_rate),
    });
  }

  const prevByKey = new Map<string, WindowRow>();
  for (const row of previous.rows) {
    prevByKey.set(`${row.provider}\u0000${row.model}`, row);
  }

  for (const trend of byKey.values()) {
    const prev = prevByKey.get(`${trend.provider}\u0000${trend.model}`);
    const currentCalls = trend.points.reduce((sum, point) => sum + point.callCount, 0);
    const currentErrors = trend.points.reduce((sum, point) => sum + point.errorCount, 0);
    const currentAvg = weightedAvg(trend.points);
    const prevCalls = prev ? num(prev.call_count) : 0;
    const prevErrors = prev ? num(prev.error_count) : 0;
    const prevAvg = prev ? nullableNum(prev.avg_ms) : null;
    const currentErrorRate = currentCalls > 0 ? currentErrors / currentCalls : 0;
    const previousErrorRate = prevCalls > 0 ? prevErrors / prevCalls : 0;
    trend.compare = {
      currentCalls,
      previousCalls: prevCalls,
      callsDeltaPct: deltaPct(currentCalls, prevCalls),
      currentErrorRate,
      previousErrorRate,
      errorRateDeltaPct: deltaPct(currentErrorRate, previousErrorRate),
      currentAvgMs: currentAvg,
      previousAvgMs: prevAvg,
      avgMsDeltaPct: currentAvg !== null && prevAvg !== null ? deltaPct(currentAvg, prevAvg) : null,
    };
  }

  return {
    evidenceClass: 'los_runtime',
    from: window.from,
    to: window.to,
    series: [...byKey.values()],
  };
}

function weightedAvg(points: readonly TrendPoint[]): number | null {
  const weighted = points.filter(point => point.avgDurationMs !== null && point.callCount > 0);
  if (weighted.length === 0) return null;
  const totalCalls = weighted.reduce((sum, point) => sum + point.callCount, 0);
  if (totalCalls === 0) return null;
  return weighted.reduce((sum, point) => sum + (point.avgDurationMs ?? 0) * point.callCount, 0) / totalCalls;
}

function emptyCompare(): TrendCompare {
  return {
    currentCalls: 0,
    previousCalls: 0,
    callsDeltaPct: null,
    currentErrorRate: 0,
    previousErrorRate: 0,
    errorRateDeltaPct: null,
    currentAvgMs: null,
    previousAvgMs: null,
    avgMsDeltaPct: null,
  };
}
