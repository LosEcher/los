/**
 * @los/infra/metrics — Minimal Prometheus text-format metrics rendering.
 *
 * Collectors (gateway /metrics route) produce MetricSample arrays; this module
 * renders them in the Prometheus exposition format. No external dependency —
 * the format is simple enough to render directly.
 */

export type MetricType = 'counter' | 'gauge';

export interface MetricSample {
  /** Prometheus metric name, e.g. los_task_runs_total. */
  name: string;
  /** Numeric value. */
  value: number;
  /** Optional label set. */
  labels?: Record<string, string>;
  /** One-line HELP text (rendered once per metric name). */
  help?: string;
  /** Metric type line (rendered once per metric name). */
  type?: MetricType;
}

export interface RenderedMetric {
  name: string;
  help?: string;
  type?: MetricType;
  lines: string[];
}

/**
 * Group samples by metric name preserving first-seen help/type, then render
 * Prometheus text format:
 *
 *   # HELP los_task_runs_total Total task runs.
 *   # TYPE los_task_runs_total counter
 *   los_task_runs_total{status="succeeded"} 12
 */
export function renderPrometheus(samples: MetricSample[]): string {
  const byName = new Map<string, RenderedMetric>();
  for (const sample of samples) {
    if (!sample.name || !Number.isFinite(sample.value)) continue;
    let rendered = byName.get(sample.name);
    if (!rendered) {
      rendered = { name: sample.name, help: sample.help, type: sample.type, lines: [] };
      byName.set(sample.name, rendered);
    }
    const labels = sample.labels && Object.keys(sample.labels).length > 0
      ? `{${formatLabels(sample.labels)}}`
      : '';
    rendered.lines.push(`${sample.name}${labels} ${sample.value}`);
  }

  const lines: string[] = [];
  for (const metric of byName.values()) {
    if (metric.help) lines.push(`# HELP ${metric.name} ${metric.help}`);
    if (metric.type) lines.push(`# TYPE ${metric.name} ${metric.type}`);
    lines.push(...metric.lines);
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

function formatLabels(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
    .join(',');
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Collect cache hit/miss token totals from execution-projection eval rows.
 * Returns { hit, miss } or null when no projection rows carry cache fields.
 */
export function summarizeCacheTokens(
  rows: Array<Record<string, unknown>>,
): { hit: number; miss: number } | null {
  let hit = 0;
  let miss = 0;
  let found = false;
  for (const row of rows) {
    const summary = row.summary_json;
    if (!summary || typeof summary !== 'object') continue;
    const record = summary as Record<string, unknown>;
    const hitValue = Number(record.cacheHitTokens ?? 0);
    const missValue = Number(record.cacheMissTokens ?? 0);
    if (Number.isFinite(hitValue) && Number.isFinite(missValue) && (hitValue > 0 || missValue > 0)) {
      hit += hitValue;
      miss += missValue;
      found = true;
    }
  }
  return found ? { hit, miss } : null;
}
