// ── fleet-overview.mjs — 机队概览的**纯逻辑**（B5，2026-10-17）──
//
// 为什么单独成 .mjs：本仓测试是 `node --test 'src/**/*.test.mjs'`，**没有 DOM**，
// 所以组件本身测不了。把"摘要怎么拼、告警条留几条"抽成纯函数，
// 就能像 `pages/fleet-topology-layout.mjs` 那样被直测。
//
// 两条规则来自 muxin 展示层实测（见 dsfolder 的 muxin 文档 D1/D4）：
//   D1 摘要**按非零条件拼装** —— 0 台工作时不该出现「0 台在工作」，那是噪声。
//   D4 **固定条数 + 显式溢出** —— 告警条最多 3 条，多的折成「+N」，不静默丢。

/** 摘要最多几段（超出说明拼装逻辑写错了，不是靠这条截断）。 */
export const SUMMARY_MAX_PARTS = 4;

/**
 * 拼装机队摘要的各段。**零值的段不出现**（D1）。
 *
 * @param {{total?: number, healthy?: number, attention?: number}} counts
 * @param {(key: string, vars?: Record<string, unknown>) => string} t
 * @returns {string[]} 非零段；**空数组表示"没有可说的"**，调用方须给空态文案
 */
export function buildSummaryParts(counts, t) {
  const total = toCount(counts?.total);
  const healthy = toCount(counts?.healthy);
  const attention = toCount(counts?.attention);
  const parts = [];
  // 总数是唯一"永远该说"的（哪怕为 1）；它不参与零值裁剪。
  if (total > 0) parts.push(t('ops.fleet.summaryTotal', { n: total }));
  if (healthy > 0) parts.push(t('ops.fleet.summaryHealthy', { n: healthy }));
  if (attention > 0) parts.push(t('ops.fleet.summaryAttention', { n: attention }));
  return parts.slice(0, SUMMARY_MAX_PARTS);
}

/**
 * 告警条只显示前 `limit` 个，其余折成溢出数（D4）。
 *
 * ⚠️ 溢出数必须**如实**等于被折掉的个数；把它静默丢掉等于"告警被藏起来"。
 *
 * @param {string[]|undefined|null} ids
 * @param {number} [limit]
 * @returns {{shown: string[], overflow: number}}
 */
export function capAttention(ids, limit = 3) {
  const list = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string' && x.trim()) : [];
  const n = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 3;
  if (list.length <= n) return { shown: list, overflow: 0 };
  return { shown: list.slice(0, n), overflow: list.length - n };
}

function toCount(v) {
  return Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
}
