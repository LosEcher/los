/**
 * Multi-agent activity timeline — concurrent session buckets + drill-down.
 *
 * Phase P0 (AgentsView Activity benchmark): answers "when were agents actually
 * working, how much overlapped, and what did it cost". A session counts as
 * active in a bucket when it has a timed event (model.response / tool.result)
 * whose [created_at, created_at + durationMs] interval spans that bucket.
 *
 * Cost attribution uses the model.response payload cost (totalCostUsd), the
 * same L1 evidence as /usage/summary. No external CLI fleets are included.
 */

import { getDb } from '@los/infra/db';

export interface ActivityQuery {
  /** Inclusive lower bound ISO timestamp. Default: now - 24 hours. */
  from?: string;
  /** Exclusive upper bound ISO timestamp. Default: now. */
  to?: string;
  /** Bucket size in minutes. Default 60; clamped to [1, 1440]. */
  bucketMinutes?: number;
  /** When present, return the sessions active inside this bucket instead of the series. */
  bucket?: string;
}

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

export interface MetricsActivity {
  evidenceClass: 'los_runtime';
  from: string;
  to: string;
  bucketSizeMinutes: number;
  buckets: ActivityBucket[];
  totals: ActivityTotals;
  /** Present only when query.bucket was supplied. */
  drilldown?: ActivityDrilldownSession[];
}

const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

interface BucketRow {
  bucket: string;
  active_sessions: string;
}

interface CostRow {
  bucket: string;
  cost: string | null;
}

interface DrilldownRow {
  session_id: string;
  active_start: string;
  active_end: string;
  event_count: string;
  cost: string | null;
}

const TIMED_EVENT_TYPES = `('model.response', 'tool.result')`;

function resolveWindow(query: ActivityQuery): { from: Date; to: Date } {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - DEFAULT_WINDOW_HOURS * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error('metrics activity requires valid from/to ISO timestamps');
  }
  if (from.getTime() >= to.getTime()) {
    throw new Error('metrics activity requires from < to');
  }
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) {
    throw new Error('metrics activity window must be <= 90 days');
  }
  return { from, to };
}

function clampBucketMinutes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 60;
  return Math.min(1440, Math.max(1, Math.floor(value)));
}

function num(value: string | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export async function getMetricsActivity(query: ActivityQuery = {}): Promise<MetricsActivity> {
  const { from, to } = resolveWindow(query);
  const bucketMinutes = clampBucketMinutes(query.bucketMinutes);
  let bucketDate: Date | null = null;
  if (query.bucket) {
    bucketDate = new Date(query.bucket);
    if (Number.isNaN(bucketDate.getTime())) {
      throw new Error('metrics activity bucket must be a valid ISO timestamp');
    }
  }
  const db = getDb();

  if (bucketDate) {
    const bucketEnd = new Date(bucketDate.getTime() + bucketMinutes * 60 * 1000);
    const rows = await db.query<DrilldownRow>(
      `SELECT
          session_id,
          MIN(created_at)::text AS active_start,
          MAX(created_at + make_interval(secs => COALESCE((payload_json->>'durationMs')::numeric, 0) / 1000.0))::text AS active_end,
          COUNT(*)::text AS event_count,
          SUM(COALESCE((payload_json->'cost'->>'totalCostUsd')::numeric, 0))::text AS cost
        FROM session_events
        WHERE type IN ${TIMED_EVENT_TYPES}
          AND created_at < $2::timestamptz
          AND created_at + make_interval(secs => COALESCE((payload_json->>'durationMs')::numeric, 0) / 1000.0) > $1::timestamptz
        GROUP BY session_id
        ORDER BY active_start ASC
        LIMIT 200`,
      [bucketDate.toISOString(), bucketEnd.toISOString()],
    );
    return {
      evidenceClass: 'los_runtime',
      from: from.toISOString(),
      to: to.toISOString(),
      bucketSizeMinutes: bucketMinutes,
      buckets: [],
      totals: emptyTotals(),
      drilldown: rows.rows.map(row => ({
        sessionId: row.session_id,
        activeStart: row.active_start,
        activeEnd: row.active_end,
        eventCount: num(row.event_count),
        estimatedCostUsd: num(row.cost),
      })),
    };
  }

  // Per-bucket concurrent sessions: a session is active in a bucket when any of
  // its timed events spans the bucket start.
  const series = await db.query<BucketRow>(
    `SELECT
        to_char(bucket AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS bucket,
        COUNT(DISTINCT e.session_id)::text AS active_sessions
      FROM generate_series(
             $1::timestamptz,
             $2::timestamptz - make_interval(mins => $3::int),
             make_interval(mins => $3::int)
           ) AS bucket
      LEFT JOIN session_events e
        ON e.type IN ${TIMED_EVENT_TYPES}
       AND e.created_at >= $1::timestamptz
       AND e.created_at < $2::timestamptz
       AND e.created_at < bucket + make_interval(mins => $3::int)
       AND e.created_at + make_interval(secs => COALESCE((e.payload_json->>'durationMs')::numeric, 0) / 1000.0) > bucket
      GROUP BY bucket
      ORDER BY bucket ASC`,
    [from.toISOString(), to.toISOString(), bucketMinutes],
  );

  const costSeries = await db.query<CostRow>(
    `SELECT
        to_char(bucket AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS bucket,
        SUM(COALESCE((e.payload_json->'cost'->>'totalCostUsd')::numeric, 0))::text AS cost
      FROM generate_series(
             $1::timestamptz,
             $2::timestamptz - make_interval(mins => $3::int),
             make_interval(mins => $3::int)
           ) AS bucket
      LEFT JOIN session_events e
        ON e.type = 'model.response'
       AND e.created_at >= $1::timestamptz
       AND e.created_at < $2::timestamptz
       AND e.created_at >= bucket
       AND e.created_at < bucket + make_interval(mins => $3::int)
      GROUP BY bucket
      ORDER BY bucket ASC`,
    [from.toISOString(), to.toISOString(), bucketMinutes],
  );

  const costByBucket = new Map<string, number>();
  for (const row of costSeries.rows) {
    costByBucket.set(row.bucket, num(row.cost));
  }

  const buckets: ActivityBucket[] = [];
  let peakConcurrent = 0;
  let peakBucket: string | null = null;
  let totalAgentMinutes = 0;
  let totalCostUsd = 0;
  for (const row of series.rows) {
    const active = num(row.active_sessions);
    const agentMinutes = active * bucketMinutes;
    const cost = costByBucket.get(row.bucket) ?? 0;
    totalAgentMinutes += agentMinutes;
    totalCostUsd += cost;
    if (active > peakConcurrent) {
      peakConcurrent = active;
      peakBucket = row.bucket;
    }
    buckets.push({
      bucket: row.bucket,
      activeSessions: active,
      agentMinutes,
      estimatedCostUsd: cost,
    });
  }

  return {
    evidenceClass: 'los_runtime',
    from: from.toISOString(),
    to: to.toISOString(),
    bucketSizeMinutes: bucketMinutes,
    buckets,
    totals: {
      peakConcurrent,
      peakBucket,
      totalAgentMinutes,
      totalCostUsd,
      sessionCount: buckets.reduce((sum, b) => sum + b.activeSessions, 0),
    },
  };
}

function emptyTotals(): ActivityTotals {
  return {
    peakConcurrent: 0,
    peakBucket: null,
    totalAgentMinutes: 0,
    totalCostUsd: 0,
    sessionCount: 0,
  };
}
