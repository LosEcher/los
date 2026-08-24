/**
 * exec-obs-scrubber.test.mjs — scrubber 数据投影属性测试（zoetrope L-1）
 *
 * 覆盖：事件索引轴（floor/len/turn 区间）、sparkline（分桶/归一化/非零列 floor=1/
 * 空输入）、失败 marker（位置映射/past-only 语义数据/排序）、汇总。纯函数零依赖。
 *
 * 运行: node --test src/exec-obs-scrubber.test.mjs（或 npm test 在 packages/web）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEventIndex,
  buildSparkline,
  buildFailureMarkers,
  buildScrubberProjection,
  collectTurnEventIds,
  SPARKLINE_LEVELS,
} from './exec-obs-scrubber.mjs';

/** 合成一个 turn（los ExecutionTurnWaterfall 形状） */
function turn(n, opts = {}) {
  const base = n * 100;
  return {
    turn: n,
    modelWait: { durationMs: opts.modelMs ?? 500, eventIds: [base + 1, base + 2] },
    toolWait: { durationMs: opts.toolMs ?? 300, eventIds: [base + 3, base + 4, base + 5] },
    retries: { count: opts.retries ?? 0, eventIds: opts.retries ? [base + 6] : [] },
    errors: { count: opts.errors ?? 0, eventIds: opts.errors ? [base + 7] : [] },
    denied: { count: opts.denied ?? 0, eventIds: opts.denied ? [base + 8] : [] },
    tokens: { promptTokens: 100, completionTokens: 50, cacheHitTokens: 0, cacheMissTokens: 0, totalTokens: 150, eventIds: [base] },
  };
}

function projection(waterfall, failureFacets = []) {
  return {
    sessionId: 's1',
    fingerprint: { status: 'known', hash: 'abc', components: {} },
    waterfall,
    failureFacets,
  };
}

test('collectTurnEventIds: 聚合该 turn 全部证据的事件 id', () => {
  const ids = collectTurnEventIds(turn(1, { retries: 1, errors: 1 }));
  assert.ok(ids.length >= 8, `收集到 ${ids.length} 个 id`);
  assert.ok(ids.includes(101) && ids.includes(107) && ids.includes(100));
});

test('buildEventIndex: floor/len/turn 区间', () => {
  const index = buildEventIndex([turn(1), turn(2)]);
  assert.equal(index.floor, 100); // turn1 最小事件 id（tokens.eventIds=[100]）
  assert.equal(index.len, 205 - 100 + 1); // 覆盖全部事件 [100..205]
  assert.equal(index.spans.length, 2);
  assert.equal(index.spans[0].turn, 1);
  assert.equal(index.spans[0].min, 100);
  assert.equal(index.spans[0].max, 105); // turn1 的事件 100..105
  assert.ok(index.spans[1].count > 0);
});

test('buildEventIndex: 空 waterfall 不崩', () => {
  const index = buildEventIndex([]);
  assert.equal(index.floor, 0);
  assert.equal(index.len, 0);
  assert.equal(index.spans.length, 0);
});

test('buildSparkline: 分桶覆盖全部活动、非零列 floor=1', () => {
  const wf = [turn(1), turn(2)];
  const spark = buildSparkline(wf, 10);
  assert.equal(spark.length, 10);
  // 事件在 turn1(100-108) 与 turn2(200-208)，事件空间 [100,208] 分 10 桶
  assert.ok(spark.some((v) => v > 0), '有活动列');
  const nonzero = spark.filter((v) => v > 0);
  assert.ok(nonzero.every((v) => v >= 1), '非零列 floor=1');
  assert.ok(nonzero.every((v) => v <= SPARKLINE_LEVELS), '不超上限');
  // 两簇事件 → 至少两个分离的活动列（两端）
  assert.ok(spark[0] >= 1, '最早桶有活动');
  assert.ok(spark[spark.length - 1] >= 1, '最晚桶有活动');
});

test('buildSparkline: 空输入全 0', () => {
  const spark = buildSparkline([], 8);
  assert.ok(spark.every((v) => v === 0));
  assert.equal(spark.length, 8);
});

test('buildSparkline: 低活动 tick 不可见问题被 floor=1 修复', () => {
  // 一个繁忙 turn（20 事件）挤在右侧，一个稀疏 turn（1 事件）在左侧；
  // 若不 floor，稀疏列会被归一化成 0。列数多到二者分桶不同。
  const busy = { ...turn(1), modelWait: { durationMs: 1, eventIds: Array.from({ length: 20 }, (_, i) => 100 + i) } };
  const sparse = { ...turn(2), tokens: { totalTokens: 1, eventIds: [200] } };
  const spark = buildSparkline([busy, sparse], 48);
  // 找到稀疏 turn(200) 所在桶：位置 (200-100)/(len) * 48
  const pos = Math.floor(((200 - 100) / (200 - 100 + 1)) * 48);
  assert.ok(spark[pos] >= 1, `稀疏列 (idx ${pos}) 有 floor=1 活动`);
});

test('buildFailureMarkers: 位置映射 + past-only 语义数据 + 排序', () => {
  const wf = [turn(1), turn(2)];
  const markers = buildFailureMarkers(
    projection(wf, [
      { category: 'tool', code: 'E1', message: 'boom', eventIds: [105], verificationRecordIds: [] },
      { category: 'provider', code: 'E2', message: null, eventIds: [202], verificationRecordIds: [] },
    ]),
  );
  assert.equal(markers.length, 2);
  assert.equal(markers[0].category, 'tool'); // 按 position 排序（105 < 202）
  assert.ok(markers[0].position != null && markers[0].position >= 0 && markers[0].position <= 1);
  assert.equal(markers[1].code, 'E2');
  // past-only 语义：position 即 playhead 阈值（UI 判定 playhead >= position 才显现）
  assert.ok(markers[1].position > markers[0].position, '后失败 marker 位置更大');
});

test('buildFailureMarkers: 无事件 id 的 facet 被过滤', () => {
  const markers = buildFailureMarkers(
    projection([turn(1)], [{ category: 'tool', code: 'E1', message: null, eventIds: [], verificationRecordIds: [] }]),
  );
  assert.equal(markers.length, 0);
});

test('buildScrubberProjection: 汇总一次取用', () => {
  const wf = [turn(1, { retries: 1, errors: 1, denied: 1 }), turn(2)];
  const out = buildScrubberProjection(projection(wf), 12);
  assert.equal(out.totals.turns, 2);
  assert.equal(out.totals.retries, 1);
  assert.equal(out.totals.errors, 1);
  assert.equal(out.totals.denied, 1);
  assert.equal(out.sparkline.length, 12);
  assert.ok(Array.isArray(out.index.turnSpans));
});
