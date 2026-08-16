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
});
