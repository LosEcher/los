/**
 * Governance auditor — performance audit.
 *
 * Collects provider-level telemetry and database table stats to surface
 * performance hotspots that need attention.
 *
 * Data sources:
 *   1. provider_call_telemetry — per-call latency/cost/tokens
 *   2. pg_stat_user_tables — table sizes and scan counts
 */
import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';

const log = getLogger('governance-jobs');

export async function runPerformanceAudit(): Promise<Record<string, unknown>> {
  const db = getDb();
  const auditedAt = new Date().toISOString();

  // ── 1. Provider call telemetry summary (last 7 days) ──
  let providerStats: any[] = [];
  try {
    const rows = await db.query<{
      provider: string;
      model: string;
      call_count: string;
      avg_latency_ms: string;
      max_latency_ms: string;
      total_cost: string;
      error_count: string;
      avg_tokens: string;
    }>(
      `SELECT
        provider, model,
        COUNT(*)::text AS call_count,
        ROUND(AVG(latency_ms)::numeric, 1)::text AS avg_latency_ms,
        MAX(latency_ms)::text AS max_latency_ms,
        ROUND(SUM(COALESCE(cost, 0))::numeric, 6)::text AS total_cost,
        COUNT(*) FILTER (WHERE is_error)::text AS error_count,
        ROUND(AVG(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)))::text AS avg_tokens
       FROM provider_call_telemetry
       WHERE created_at > now() - INTERVAL '7 days'
       GROUP BY provider, model
       ORDER BY call_count DESC`,
    );
    providerStats = rows.rows.map(r => ({
      provider: r.provider,
      model: r.model,
      callCount: Number(r.call_count),
      avgLatencyMs: Number(r.avg_latency_ms),
      maxLatencyMs: Number(r.max_latency_ms),
      totalCost: Number(r.total_cost),
      errorCount: Number(r.error_count),
      errorRate: Number(r.call_count) > 0
        ? Math.round((Number(r.error_count) / Number(r.call_count)) * 100)
        : 0,
      avgTokens: Number(r.avg_tokens),
    }));
  } catch (err) {
    log.warn(`Performance: provider_call_telemetry query failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── 2. Largest tables by row count ──
  let largeTables: any[] = [];
  try {
    const tableRows = await db.query<{
      table_name: string;
      row_estimate: string;
      total_bytes: string;
    }>(
      `SELECT
        relname AS table_name,
        n_live_tup::text AS row_estimate,
        pg_total_relation_size(relid)::text AS total_bytes
       FROM pg_stat_user_tables
       ORDER BY n_live_tup DESC
       LIMIT 20`,
    );
    largeTables = tableRows.rows
      .map(r => ({
        table: r.table_name,
        rows: Number(r.row_estimate),
        sizeMB: Math.round(Number(r.total_bytes) / (1024 * 1024)),
      }))
      .filter(t => t.rows > 0);
  } catch (err) {
    log.warn(`Performance: pg_stat_user_tables query failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── 3. Identify slow providers (>500ms avg latency) ──
  const slowProviders = providerStats.filter(p => p.avgLatencyMs > 500);
  // ── 4. Identify error-prone providers (>5% error rate) ──
  const errorProneProviders = providerStats.filter(p => p.errorRate > 5);
  // ── 5. Identify large tables (>100k rows) ──
  const veryLargeTables = largeTables.filter(t => t.rows > 100_000);

  return {
    auditedAt,
    providerStats,
    slowProviderCount: slowProviders.length,
    errorProneProviderCount: errorProneProviders.length,
    slowProviders: slowProviders.map(p => ({ provider: p.provider, model: p.model, avgLatencyMs: p.avgLatencyMs })),
    errorProneProviders: errorProneProviders.map(p => ({ provider: p.provider, model: p.model, errorRate: p.errorRate })),
    largeTableCount: largeTables.length,
    veryLargeTableCount: veryLargeTables.length,
    topLargeTables: largeTables.slice(0, 5),
    totalProviderCalls: providerStats.reduce((sum, p) => sum + p.callCount, 0),
    totalProviderErrors: providerStats.reduce((sum, p) => sum + p.errorCount, 0),
    totalProviderCost: providerStats.reduce((sum, p) => sum + p.totalCost, 0),
  };
}
