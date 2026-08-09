/**
 * L1 runtime usage cube — aggregates los-owned execution evidence.
 *
 * Primary surface: session_events type=model.response (token + cost).
 * Secondary: provider_call_telemetry (call counts, latency, usage fill rate).
 *
 * External CLI fleets (ccusage/ccglass) are NOT included here — see ADR 0019
 * and docs/operations/2026-08-09-usage-hub-design.md.
 */

import { getDb } from '@los/infra/db';

export type UsageEvidenceClass = 'los_runtime';

export interface UsageSummaryQuery {
  /** Inclusive lower bound ISO timestamp. Default: now - 7 days. */
  from?: string;
  /** Exclusive upper bound ISO timestamp. Default: now. */
  to?: string;
  /** Optional provider filter (exact). */
  provider?: string;
  /** Optional model filter (exact). */
  model?: string;
}

export interface UsageTotals {
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
}

export interface UsageProviderModelRow {
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
}

export interface UsageDayRow {
  day: string;
  modelResponseCount: number;
  sessionCount: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  estimatedCostUsd: number;
}

export interface UsageCallTelemetryRow {
  provider: string;
  model: string;
  callCount: number;
  errorCount: number;
  avgDurationMs: number | null;
  withUsageCount: number;
  usageFillRate: number | null;
}

export interface UsageSummary {
  evidenceClass: UsageEvidenceClass;
  from: string;
  to: string;
  totals: UsageTotals;
  byProviderModel: UsageProviderModelRow[];
  byDay: UsageDayRow[];
  callTelemetry: UsageCallTelemetryRow[];
}

interface AggRow {
  provider: string | null;
  model: string | null;
  model_response_count: string;
  session_count: string;
  prompt_tokens: string | null;
  completion_tokens: string | null;
  cache_hit_tokens: string | null;
  cache_miss_tokens: string | null;
  estimated_cost_usd: string | null;
  cache_savings_usd: string | null;
}

interface DayRow {
  day: string;
  model_response_count: string;
  session_count: string;
  prompt_tokens: string | null;
  completion_tokens: string | null;
  cache_hit_tokens: string | null;
  estimated_cost_usd: string | null;
}

interface CallRow {
  provider: string;
  model: string;
  call_count: string;
  error_count: string;
  avg_duration_ms: string | null;
  with_usage_count: string;
}

function resolveWindow(query: UsageSummaryQuery): { from: string; to: string } {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error('usage summary requires valid from/to ISO timestamps');
  }
  if (from.getTime() >= to.getTime()) {
    throw new Error('usage summary requires from < to');
  }
  // Cap window at 90 days to keep scans bounded.
  const maxMs = 90 * 24 * 60 * 60 * 1000;
  if (to.getTime() - from.getTime() > maxMs) {
    throw new Error('usage summary window must be <= 90 days');
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

function num(value: string | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function buildFilters(query: UsageSummaryQuery, startIndex: number): {
  sql: string;
  params: unknown[];
  nextIndex: number;
} {
  const params: unknown[] = [];
  const clauses: string[] = [];
  let i = startIndex;
  if (query.provider) {
    clauses.push(`AND COALESCE(payload_json->>'provider', 'unknown') = $${i++}`);
    params.push(query.provider);
  }
  if (query.model) {
    clauses.push(`AND COALESCE(model, 'unknown') = $${i++}`);
    params.push(query.model);
  }
  return { sql: clauses.join(' '), params, nextIndex: i };
}

export async function getUsageSummary(query: UsageSummaryQuery = {}): Promise<UsageSummary> {
  const window = resolveWindow(query);
  const db = getDb();
  const baseParams: unknown[] = [window.from, window.to];
  const filters = buildFilters(query, 3);
  const params = [...baseParams, ...filters.params];

  const byProviderModel = await db.query<AggRow>(
    `SELECT
        COALESCE(payload_json->>'provider', 'unknown') AS provider,
        COALESCE(model, 'unknown') AS model,
        COUNT(*)::text AS model_response_count,
        COUNT(DISTINCT session_id)::text AS session_count,
        SUM(COALESCE((usage_json->>'promptTokens')::numeric, 0))::text AS prompt_tokens,
        SUM(COALESCE((usage_json->>'completionTokens')::numeric, 0))::text AS completion_tokens,
        SUM(COALESCE((usage_json->>'cacheHitTokens')::numeric, 0))::text AS cache_hit_tokens,
        SUM(COALESCE((usage_json->>'cacheMissTokens')::numeric, 0))::text AS cache_miss_tokens,
        SUM(COALESCE((payload_json->'cost'->>'totalCostUsd')::numeric, 0))::text AS estimated_cost_usd,
        SUM(COALESCE((payload_json->'cost'->>'cacheSavingsUsd')::numeric, 0))::text AS cache_savings_usd
      FROM session_events
      WHERE type = 'model.response'
        AND created_at >= $1::timestamptz
        AND created_at < $2::timestamptz
        ${filters.sql}
      GROUP BY 1, 2
      ORDER BY SUM(COALESCE((payload_json->'cost'->>'totalCostUsd')::numeric, 0)) DESC,
               COUNT(*) DESC
      LIMIT 100`,
    params,
  );

  const byDay = await db.query<DayRow>(
    `SELECT
        to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
        COUNT(*)::text AS model_response_count,
        COUNT(DISTINCT session_id)::text AS session_count,
        SUM(COALESCE((usage_json->>'promptTokens')::numeric, 0))::text AS prompt_tokens,
        SUM(COALESCE((usage_json->>'completionTokens')::numeric, 0))::text AS completion_tokens,
        SUM(COALESCE((usage_json->>'cacheHitTokens')::numeric, 0))::text AS cache_hit_tokens,
        SUM(COALESCE((payload_json->'cost'->>'totalCostUsd')::numeric, 0))::text AS estimated_cost_usd
      FROM session_events
      WHERE type = 'model.response'
        AND created_at >= $1::timestamptz
        AND created_at < $2::timestamptz
        ${filters.sql}
      GROUP BY 1
      ORDER BY 1 ASC`,
    params,
  );

  // Call-level latency surface (may lag session usage fill rate until P0 writeback ships).
  const callFilters: string[] = [];
  const callParams: unknown[] = [window.from, window.to];
  let ci = 3;
  if (query.provider) {
    callFilters.push(`AND provider = $${ci++}`);
    callParams.push(query.provider);
  }
  if (query.model) {
    callFilters.push(`AND model = $${ci++}`);
    callParams.push(query.model);
  }
  const callTelemetry = await db.query<CallRow>(
    `SELECT
        provider,
        model,
        COUNT(*)::text AS call_count,
        SUM(CASE WHEN status >= 400 OR status = 0 THEN 1 ELSE 0 END)::text AS error_count,
        AVG(duration_ms)::text AS avg_duration_ms,
        SUM(CASE WHEN usage_json IS NOT NULL AND usage_json::text NOT IN ('{}', 'null') THEN 1 ELSE 0 END)::text AS with_usage_count
      FROM provider_call_telemetry
      WHERE created_at >= $1::timestamptz
        AND created_at < $2::timestamptz
        ${callFilters.join(' ')}
      GROUP BY provider, model
      ORDER BY COUNT(*) DESC
      LIMIT 100`,
    callParams,
  ).catch(() => ({ rows: [] as CallRow[] }));

  const providerModelRows: UsageProviderModelRow[] = byProviderModel.rows.map(row => ({
    provider: row.provider ?? 'unknown',
    model: row.model ?? 'unknown',
    modelResponseCount: num(row.model_response_count),
    sessionCount: num(row.session_count),
    promptTokens: num(row.prompt_tokens),
    completionTokens: num(row.completion_tokens),
    cacheHitTokens: num(row.cache_hit_tokens),
    cacheMissTokens: num(row.cache_miss_tokens),
    estimatedCostUsd: num(row.estimated_cost_usd),
    cacheSavingsUsd: num(row.cache_savings_usd),
  }));

  const totals = providerModelRows.reduce<UsageTotals>(
    (acc, row) => {
      acc.modelResponseCount += row.modelResponseCount;
      acc.sessionCount += row.sessionCount;
      acc.promptTokens += row.promptTokens;
      acc.completionTokens += row.completionTokens;
      acc.cacheHitTokens += row.cacheHitTokens;
      acc.cacheMissTokens += row.cacheMissTokens;
      acc.estimatedCostUsd += row.estimatedCostUsd;
      acc.cacheSavingsUsd += row.cacheSavingsUsd;
      return acc;
    },
    {
      modelResponseCount: 0,
      sessionCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      cacheSavingsUsd: 0,
      cacheHitRate: null,
    },
  );
  // sessionCount above double-counts sessions across models; recompute distinct.
  const sessionDistinct = await db.query<{ session_count: string }>(
    `SELECT COUNT(DISTINCT session_id)::text AS session_count
      FROM session_events
      WHERE type = 'model.response'
        AND created_at >= $1::timestamptz
        AND created_at < $2::timestamptz
        ${filters.sql}`,
    params,
  );
  totals.sessionCount = num(sessionDistinct.rows[0]?.session_count);
  totals.totalTokens = totals.promptTokens + totals.completionTokens;
  const cacheDenom = totals.cacheHitTokens + totals.cacheMissTokens;
  totals.cacheHitRate = cacheDenom > 0 ? totals.cacheHitTokens / cacheDenom : null;

  return {
    evidenceClass: 'los_runtime',
    from: window.from,
    to: window.to,
    totals,
    byProviderModel: providerModelRows,
    byDay: byDay.rows.map(row => ({
      day: row.day,
      modelResponseCount: num(row.model_response_count),
      sessionCount: num(row.session_count),
      promptTokens: num(row.prompt_tokens),
      completionTokens: num(row.completion_tokens),
      cacheHitTokens: num(row.cache_hit_tokens),
      estimatedCostUsd: num(row.estimated_cost_usd),
    })),
    callTelemetry: callTelemetry.rows.map(row => {
      const callCount = num(row.call_count);
      const withUsageCount = num(row.with_usage_count);
      return {
        provider: row.provider,
        model: row.model,
        callCount,
        errorCount: num(row.error_count),
        avgDurationMs: row.avg_duration_ms === null ? null : num(row.avg_duration_ms),
        withUsageCount,
        usageFillRate: callCount > 0 ? withUsageCount / callCount : null,
      };
    }),
  };
}
