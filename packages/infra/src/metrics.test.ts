import test from 'node:test';
import assert from 'node:assert/strict';

import { renderPrometheus, summarizeCacheTokens, type MetricSample } from './metrics.js';

test('renderPrometheus emits HELP, TYPE, and labelled samples', () => {
  const samples: MetricSample[] = [
    { name: 'los_task_runs_total', value: 3, labels: { status: 'succeeded' }, help: 'Total task runs.', type: 'counter' },
    { name: 'los_task_runs_total', value: 1, labels: { status: 'failed' } },
    { name: 'los_cache_hit_tokens_total', value: 42, type: 'counter' },
  ];
  const output = renderPrometheus(samples);
  assert.match(output, /^# HELP los_task_runs_total Total task runs\.$/m);
  assert.match(output, /^# TYPE los_task_runs_total counter$/m);
  assert.match(output, /^los_task_runs_total\{status="succeeded"\} 3$/m);
  assert.match(output, /^los_task_runs_total\{status="failed"\} 1$/m);
  assert.match(output, /^los_cache_hit_tokens_total 42$/m);
  assert.ok(output.endsWith('\n'));
});

test('renderPrometheus escapes label values and skips non-finite values', () => {
  const output = renderPrometheus([
    { name: 'm', value: 1, labels: { provider: 'a"b\\c' } },
    { name: 'm', value: Number.NaN },
    { name: 'm', value: Number.POSITIVE_INFINITY },
  ]);
  assert.match(output, /^m\{provider="a\\"b\\\\c"\} 1$/m);
  assert.doesNotMatch(output, /NaN/);
  assert.doesNotMatch(output, /Infinity/);
});

test('summarizeCacheTokens aggregates projection rows and returns null when absent', () => {
  const rows = [
    { summary_json: { cacheHitTokens: 10, cacheMissTokens: 20, kind: 'pairwise' } },
    { summary_json: { cacheHitTokens: 5, cacheMissTokens: 0 } },
    { summary_json: { other: true } },
  ];
  assert.deepEqual(summarizeCacheTokens(rows), { hit: 15, miss: 20 });

  assert.equal(summarizeCacheTokens([{ summary_json: { other: true } }]), null);
  assert.equal(summarizeCacheTokens([{ summary_json: null }]), null);
});
