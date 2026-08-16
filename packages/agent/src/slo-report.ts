import { getDb } from '@los/infra/db';

/**
 * Main-path SLO report (roadmap R2).
 *
 * Aggregates task_runs into per provider/model/kernel groups with explicit
 * proxy indicators (see contracts/slo.yaml for the indicator definitions).
 * The report is a read model over persisted evidence — it never infers success
 * (AP3: cross-reference verification_records before drawing conclusions).
 */

export interface SloGroup {
  provider: string;
  model: string;
  kernel: string;
  runs: number;
  succeeded: number;
  blocked: number;
  failed: number;
  cancelled: number;
  completionRate: number;
  interventionRate: number;
  recoveryAttempts: number;
  recoverySucceeded: number;
  recoveryRate: number;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
}

export interface SloReport {
  generatedAt: string;
  windowDays: number;
  groups: SloGroup[];
}

export interface BuildSloReportOptions {
  /** Lookback window in days; default 7. */
  windowDays?: number;
}

type SloRow = {
  provider: string;
  model: string;
  kernel: string;
  runs: string;
  succeeded: string;
  blocked: string;
  failed: string;
  cancelled: string;
  recovery_attempts: string;
  recovery_succeeded: string;
  p50_ms: string | null;
  p95_ms: string | null;
};

const TERMINAL = `status IN ('succeeded', 'failed', 'blocked', 'cancelled')`;

export async function buildSloReport(options: BuildSloReportOptions = {}): Promise<SloReport> {
  const windowDays = Math.min(Math.max(options.windowDays ?? 7, 1), 90);
  const db = getDb();
  const rows = await db.query<SloRow>(
    `SELECT
       COALESCE(provider, '(unknown)') AS provider,
       COALESCE(model, '(unknown)') AS model,
       COALESCE(metadata_json->'executionKernel'->>'kind', 'los') AS kernel,
       count(*) AS runs,
       count(*) FILTER (WHERE status = 'succeeded') AS succeeded,
       count(*) FILTER (WHERE status = 'blocked') AS blocked,
       count(*) FILTER (WHERE status = 'failed') AS failed,
       count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
       count(*) FILTER (WHERE attempt > 1) AS recovery_attempts,
       count(*) FILTER (WHERE attempt > 1 AND status = 'succeeded') AS recovery_succeeded,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)::bigint AS p50_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)::bigint AS p95_ms
     FROM task_runs
     WHERE created_at > now() - ($1::int * interval '1 day')
       AND ${TERMINAL}
     GROUP BY provider, model, kernel
     ORDER BY runs DESC
     LIMIT 200`,
    [windowDays],
  );

  const groups: SloGroup[] = rows.rows.map((row) => {
    const runs = Number(row.runs);
    const succeeded = Number(row.succeeded);
    const blocked = Number(row.blocked);
    const failed = Number(row.failed);
    const cancelled = Number(row.cancelled);
    const recoveryAttempts = Number(row.recovery_attempts);
    const recoverySucceeded = Number(row.recovery_succeeded);
    const denominator = succeeded + failed + blocked;
    return {
      provider: row.provider,
      model: row.model,
      kernel: row.kernel,
      runs,
      succeeded,
      blocked,
      failed,
      cancelled,
      completionRate: denominator > 0 ? succeeded / denominator : 0,
      interventionRate: runs > 0 ? blocked / runs : 0,
      recoveryAttempts,
      recoverySucceeded,
      recoveryRate: recoveryAttempts > 0 ? recoverySucceeded / recoveryAttempts : 0,
      p50DurationMs: row.p50_ms !== null ? Number(row.p50_ms) : null,
      p95DurationMs: row.p95_ms !== null ? Number(row.p95_ms) : null,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    groups,
  };
}
