/**
 * Metrics routes — Prometheus text-format metrics endpoint.
 *
 * GET /metrics aggregates persisted execution evidence:
 *   - task run counts by status + duration (started_at → completed_at)
 *   - run eval counts, tool errors, model cost
 *   - provider call counts/errors/duration (provider_call_telemetry)
 *   - cache hit/miss token totals (execution-projection eval rows)
 *
 * Labels are documented in docs/operations/metrics.md.
 */

import type { FastifyInstance } from 'fastify';
import { getDb } from '@los/infra/db';
import { renderPrometheus, summarizeCacheTokens, type MetricSample } from '@los/infra/metrics';
import { ensureTaskRunStore } from '@los/agent/task-runs';
import { ensureRunEvalStore } from '@los/agent/run-evals';
import { ensureProviderCallTelemetryStore } from '@los/agent/providers/telemetry';

type MetricsRouteDependencies = {
  ensureRunEvalStore: typeof ensureRunEvalStore;
  ensureTaskRunStore: typeof ensureTaskRunStore;
  ensureProviderCallTelemetryStore: typeof ensureProviderCallTelemetryStore;
};

const defaultDependencies: MetricsRouteDependencies = {
  ensureRunEvalStore,
  ensureTaskRunStore,
  ensureProviderCallTelemetryStore,
};

interface CountRow { status: string; count: string; avg_ms: string | null; max_ms: string | null }
interface EvalRow { success: boolean; count: string }
interface EvalTotalsRow { tool_errors: string | null; model_cost: string | null }
interface ProviderRow { provider: string; count: string; errors: string; avg_ms: string | null }
interface SummaryRow { summary_json: unknown }

export async function collectPrometheusSamples(
  deps: MetricsRouteDependencies = defaultDependencies,
): Promise<MetricSample[]> {
  const db = getDb();
  const samples: MetricSample[] = [];

  await Promise.all([
    deps.ensureTaskRunStore(),
    deps.ensureRunEvalStore(),
    deps.ensureProviderCallTelemetryStore(),
  ]);

  // 1. Task runs by status + duration
  const taskRuns = await db.query<CountRow>(
    `SELECT status, COUNT(*)::text AS count,
            AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)::text AS avg_ms,
            MAX(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)::text AS max_ms
     FROM task_runs
     WHERE started_at IS NOT NULL
     GROUP BY status`,
  );
  for (const row of taskRuns.rows) {
    samples.push({
      name: 'los_task_runs_total',
      value: Number(row.count),
      labels: { status: row.status },
      help: 'Total task runs by final status.',
      type: 'counter',
    });
    if (row.avg_ms !== null) {
      samples.push({
        name: 'los_task_run_duration_milliseconds',
        value: Number(row.avg_ms),
        labels: { status: row.status, quantile: 'avg' },
        help: 'Task run duration from started_at to completed_at.',
        type: 'gauge',
      });
    }
    if (row.max_ms !== null) {
      samples.push({
        name: 'los_task_run_duration_milliseconds',
        value: Number(row.max_ms),
        labels: { status: row.status, quantile: 'max' },
      });
    }
  }

  // 2. Run evals: success split, tool errors, model cost
  const evals = await db.query<EvalRow>(
    `SELECT success, COUNT(*)::text AS count FROM run_evals GROUP BY success`,
  );
  for (const row of evals.rows) {
    samples.push({
      name: 'los_run_evals_total',
      value: Number(row.count),
      labels: { success: String(row.success) },
      help: 'Run evals by success flag.',
      type: 'counter',
    });
  }
  const evalTotals = await db.query<EvalTotalsRow>(
    `SELECT SUM(tool_error_count)::text AS tool_errors, SUM(model_cost)::text AS model_cost FROM run_evals`,
  );
  if (evalTotals.rows[0]?.tool_errors !== null) {
    samples.push({
      name: 'los_tool_errors_total',
      value: Number(evalTotals.rows[0]!.tool_errors ?? 0),
      help: 'Total tool errors observed in run evals.',
      type: 'counter',
    });
  }
  if (evalTotals.rows[0]?.model_cost !== null) {
    samples.push({
      name: 'los_model_cost_total',
      value: Number(evalTotals.rows[0]!.model_cost ?? 0),
      help: 'Total model cost observed in run evals.',
      type: 'counter',
    });
  }

  // 3. Provider calls by provider
  const providers = await db.query<ProviderRow>(
    `SELECT provider, COUNT(*)::text AS count,
            SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END)::text AS errors,
            AVG(duration_ms)::text AS avg_ms
     FROM provider_call_telemetry
     GROUP BY provider`,
  );
  for (const row of providers.rows) {
    samples.push({
      name: 'los_provider_calls_total',
      value: Number(row.count),
      labels: { provider: row.provider },
      help: 'Provider calls by provider.',
      type: 'counter',
    });
    samples.push({
      name: 'los_provider_errors_total',
      value: Number(row.errors),
      labels: { provider: row.provider },
      help: 'Provider calls with status >= 400.',
      type: 'counter',
    });
    if (row.avg_ms !== null) {
      samples.push({
        name: 'los_provider_duration_milliseconds',
        value: Number(row.avg_ms),
        labels: { provider: row.provider },
        help: 'Average provider call duration.',
        type: 'gauge',
      });
    }
  }

  // 4. Cache hit/miss totals from execution-projection eval rows
  const cacheRows = await db.query<SummaryRow>(
    `SELECT summary_json FROM run_evals WHERE summary_json IS NOT NULL LIMIT 1000`,
  );
  const cache = summarizeCacheTokens(cacheRows.rows.map(row => ({ summary_json: row.summary_json })));
  if (cache) {
    samples.push({
      name: 'los_cache_hit_tokens_total',
      value: cache.hit,
      help: 'Total cache hit tokens across execution-projection evals.',
      type: 'counter',
    });
    samples.push({
      name: 'los_cache_miss_tokens_total',
      value: cache.miss,
      help: 'Total cache miss tokens across execution-projection evals.',
      type: 'counter',
    });
  }

  return samples;
}

export function registerMetricsRoutes(
  app: FastifyInstance,
  overrides: Partial<MetricsRouteDependencies> = {},
): void {
  const dependencies = { ...defaultDependencies, ...overrides };
  app.get('/metrics', async () => {
    const samples = await collectPrometheusSamples(dependencies);
    return renderPrometheus(samples);
  });
}
