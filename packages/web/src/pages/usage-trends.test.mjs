import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

describe('usage trends (Phase 3) wiring', () => {
  it('defines sparkline over finite values with area fill', () => {
    const spark = read('pages/sparkline.tsx');
    assert.match(spark, /export function Sparkline/);
    assert.match(spark, /polyline/);
    assert.match(spark, /linearGradient/);
    assert.match(spark, /sparkline-empty/);
  });

  it('defines trends section with delta arrows and p50 sparkline', () => {
    const section = read('pages/usage-trends-section.tsx');
    assert.match(section, /export function UsageTrendsSection/);
    assert.match(section, /export interface MetricsTrendsResponse/);
    assert.match(section, /p50DurationMs/);
    assert.match(section, /callsDeltaPct/);
    assert.match(section, /avgMsDeltaPct/);
    assert.match(section, /ArrowUpRight/);
    assert.match(section, /Sparkline/);
  });

  it('usage page consumes /metrics/trends and renders trend column + section', () => {
    const page = read('pages/usage-page.tsx');
    assert.match(page, /metrics\/trends/);
    assert.match(page, /UsageTrendsSection/);
    assert.match(page, /colLatencyTrend/);
    assert.match(page, /export function trendP50Series/);
  });

  it('backend exposes GET /metrics/trends with p50/p95 aggregation', () => {
    const trends = read('../../../packages/agent/src/metrics-trends.ts');
    assert.match(trends, /export async function getMetricsTrends/);
    assert.match(trends, /percentile_cont\(0\.5\)/);
    assert.match(trends, /percentile_cont\(0\.95\)/);
    assert.match(trends, /usage_fill_rate/);
    const routes = read('../../../packages/gateway/src/routes/infrastructure/usage-routes.ts');
    assert.match(routes, /getMetricsTrends/);
    assert.match(routes, /'\/metrics\/trends'/);
  });

  it('registers trend keys in both locales', () => {
    const en = read('i18n/en/ops2.ts');
    const zh = read('i18n/zh/ops2.ts');
    for (const key of ['ops.usage.trendsTitle', 'ops.usage.colLatencyTrend', 'ops.usage.trendVsPrevious']) {
      assert.match(en, new RegExp(`'${key}'`), `en missing ${key}`);
      assert.match(zh, new RegExp(`'${key}'`), `zh missing ${key}`);
    }
  });

  it('defines activity panel with chart, drill-down, and session jump', () => {
    const panel = read('pages/activity-panel.tsx');
    assert.match(panel, /export function ActivityPanel/);
    assert.match(panel, /metrics\/activity/);
    assert.match(panel, /activity-bar/);
    assert.match(panel, /drilldown/);
    assert.match(panel, /los\.activity\.session/);
    assert.match(panel, /peakConcurrent/);
    const sessions = read('pages/sessions-page.tsx');
    assert.match(sessions, /los\.activity\.session/);
    const usage = read('pages/usage-page.tsx');
    assert.match(usage, /ActivityPanel/);
  });

  it('backend exposes GET /metrics/activity with concurrency bucketing', () => {
    const activity = read('../../../packages/agent/src/metrics-activity.ts');
    assert.match(activity, /export async function getMetricsActivity/);
    assert.match(activity, /generate_series/);
    assert.match(activity, /COUNT\(DISTINCT e\.session_id\)/);
    assert.match(activity, /activeSessions/);
    assert.match(activity, /drilldown/);
    assert.match(activity, /AT TIME ZONE 'UTC'/);
    const routes = read('../../../packages/gateway/src/routes/infrastructure/usage-routes.ts');
    assert.match(routes, /getMetricsActivity/);
    assert.match(routes, /'\/metrics\/activity'/);
  });
});
