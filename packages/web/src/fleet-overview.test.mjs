// fleet-overview.mjs 的断言式测试（B5 验收）。
// 断言即规格：D1 摘要零值不出现；D4 告警条固定 3 条 + 溢出数如实。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSummaryParts, capAttention, SUMMARY_MAX_PARTS } from './fleet-overview.mjs';

// 假翻译器：把 key 与 vars 原样拼出来，便于断言"哪些段被要求渲染"
const t = (key, vars) => `${key}${vars ? `(${Object.values(vars).join(',')})` : ''}`;

test('D1 摘要：0 台时不得出现任何"0"段（负向控制）', () => {
  assert.deepEqual(buildSummaryParts({ total: 0, healthy: 0, attention: 0 }, t), []);
  assert.deepEqual(buildSummaryParts({}, t), []);
  assert.deepEqual(buildSummaryParts(undefined, t), []);
  // 关键：没有任何一段包含 0
  for (const p of buildSummaryParts({ total: 0, healthy: 0, attention: 3 }, t)) {
    assert.ok(!p.includes(',0'), `不该出现 0：${p}`);
  }
});

test('D1 摘要：健康为 0 时"健康"段不出现，但总数与关注段照常', () => {
  const parts = buildSummaryParts({ total: 4, healthy: 0, attention: 2 }, t);
  assert.equal(parts.length, 2, `实得 ${JSON.stringify(parts)}`);
  assert.ok(parts[0].startsWith('ops.fleet.summaryTotal'));
  assert.ok(parts[1].startsWith('ops.fleet.summaryAttention'));
  assert.ok(!parts.some((p) => p.startsWith('ops.fleet.summaryHealthy')));
});

test('D1 摘要：全部非零时三段齐全、顺序稳定（总数→健康→关注）', () => {
  const parts = buildSummaryParts({ total: 5, healthy: 3, attention: 2 }, t);
  assert.deepEqual(parts.map((p) => p.split('(')[0]), [
    'ops.fleet.summaryTotal', 'ops.fleet.summaryHealthy', 'ops.fleet.summaryAttention',
  ]);
});

test('D1 摘要：非法/负值按 0 处理，不得渲染成负数', () => {
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '3', null]) {
    const parts = buildSummaryParts({ total: bad, healthy: bad, attention: bad }, t);
    assert.deepEqual(parts, [], `输入 ${String(bad)} 应视作 0`);
  }
});

test('D1 摘要：段数不超过上限（拼装逻辑写错时也不会无限长）', () => {
  const parts = buildSummaryParts({ total: 1, healthy: 1, attention: 1 }, t);
  assert.ok(parts.length <= SUMMARY_MAX_PARTS);
});

test('D4 告警条：不超过 3 条时原样显示、溢出为 0', () => {
  assert.deepEqual(capAttention([]), { shown: [], overflow: 0 });
  assert.deepEqual(capAttention(['a']), { shown: ['a'], overflow: 0 });
  assert.deepEqual(capAttention(['a', 'b', 'c']), { shown: ['a', 'b', 'c'], overflow: 0 });
});

test('D4 告警条：超过 3 条折成溢出数，且**溢出数必须如实**（负向控制）', () => {
  const r = capAttention(['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(r.shown, ['a', 'b', 'c']);
  assert.equal(r.overflow, 2);
  // 静默丢掉告警的写法会让 overflow 对不上；这条锁住它
  assert.equal(r.shown.length + r.overflow, 5);
});

test('D4 告警条：过滤空值，不让 "" 占一个位置', () => {
  assert.deepEqual(capAttention(['a', '', null, undefined, '  ', 'b']), { shown: ['a', 'b'], overflow: 0 });
});

test('D4 告警条：非法输入不得抛', () => {
  assert.deepEqual(capAttention(undefined), { shown: [], overflow: 0 });
  assert.deepEqual(capAttention(null), { shown: [], overflow: 0 });
  assert.deepEqual(capAttention('not-an-array'), { shown: [], overflow: 0 });
});

test('D4 告警条：可指定 limit；非法 limit 回落 3', () => {
  assert.deepEqual(capAttention(['a', 'b'], 1), { shown: ['a'], overflow: 1 });
  assert.deepEqual(capAttention(['a', 'b', 'c', 'd'], 0), { shown: ['a', 'b', 'c'], overflow: 1 });
  assert.deepEqual(capAttention(['a', 'b', 'c', 'd'], Number.NaN), { shown: ['a', 'b', 'c'], overflow: 1 });
});
