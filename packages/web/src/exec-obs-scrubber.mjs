/**
 * exec-obs-scrubber.mjs — 回放 scrubber 数据投影（zoetrope L-1 借鉴）
 *
 * 把 execution-observability projection（waterfall/failureFacets）投影为回放
 * scrubber 三件套的数据模型，纯函数、零依赖：
 *   1. buildEventIndex    事件索引轴（zoetrope：scrubber 按事件索引而非时间线性，
 *                          真实会话工作聚集后闲置数小时，时间线性条把动作埋进一像素）
 *   2. buildSparkline     工具活动 sparkline（每列活动强度，归一化 + floor=1，
 *                          否则最忙列把其余缩没、低活动列取整成 0 不可见）
 *   3. buildFailureMarkers 失败 marker（failureFacets → 事件相对位置；past-only
 *                          语义：随 playhead 到达才显现，由 UI 层用 playhead 判定）
 *
 * 输入形状 = GET /sessions/:id/execution-observability 的
 * ExecutionObservabilityProjection（waterfall 每条带 eventIds = 事件索引基础）。
 */

export const DEFAULT_COLUMNS = 48;
/** sparkline 归一化级别（对齐 zoetrope 的 rows×8；呈现层可按行数缩放） */
export const SPARKLINE_LEVELS = 16;

/** 收集一个 turn 的所有事件 id（modelWait/toolWait/retries/errors/denied/tokens 各证据的 eventIds） */
export function collectTurnEventIds(turn) {
  const ids = [];
  for (const key of ['modelWait', 'toolWait', 'retries', 'errors', 'denied', 'tokens']) {
    const evidence = turn?.[key];
    if (evidence && Array.isArray(evidence.eventIds)) ids.push(...evidence.eventIds);
  }
  return ids;
}

/** 事件索引轴：[floor, len] + 每 turn 的事件区间。floor 是不可避免的起始簇（同源同 ID 只能原子折叠） */
export function buildEventIndex(waterfall) {
  const spans = (waterfall ?? []).map((turn) => {
    const ids = collectTurnEventIds(turn);
    return {
      turn: turn.turn,
      min: ids.length ? Math.min(...ids) : null,
      max: ids.length ? Math.max(...ids) : null,
      count: ids.length,
    };
  });
  const bounds = spans.flatMap((s) => (s.min != null ? [s.min, s.max] : []));
  const floor = bounds.length ? Math.min(...bounds) : 0;
  const len = bounds.length ? Math.max(...bounds) - floor + 1 : 0;
  return { floor, len, spans };
}

/** 事件相对位置（0..1）；无事件返回 null */
export function eventPosition(eventId, index) {
  if (index.len <= 0) return null;
  return (eventId - index.floor) / index.len;
}

/**
 * 工具活动 sparkline：把事件 ID 空间分桶（columns 列），每列 = 落入该区间的事件数。
 * 归一化到 [0..SPARKLINE_LEVELS]，**非零列 floor=1**（否则最忙列把其余缩到 0，
 * 低活动 tick 取整后不可见——zoetrope 明确记录的坑）。
 * 返回长度 = columns 的整数数组（0=无活动）。
 */
export function buildSparkline(waterfall, columns = DEFAULT_COLUMNS) {
  const index = buildEventIndex(waterfall);
  const buckets = new Array(Math.max(1, columns)).fill(0);
  for (const turn of waterfall ?? []) {
    for (const id of collectTurnEventIds(turn)) {
      const pos = eventPosition(id, index);
      if (pos == null) continue;
      const idx = Math.min(buckets.length - 1, Math.max(0, Math.floor(pos * buckets.length)));
      buckets[idx] += 1;
    }
  }
  const max = Math.max(...buckets, 1);
  return buckets.map((c) => (c === 0 ? 0 : Math.max(1, Math.ceil((c / max) * SPARKLINE_LEVELS))));
}

/**
 * 失败 marker：failureFacets → 事件相对位置。
 * past-only 语义：marker 只在 playhead >= position 时显现（UI 层判定），
 * 与事件溯源一致——回放到哪揭示到哪，seek 回退 marker 消失。
 */
export function buildFailureMarkers(projection) {
  const index = buildEventIndex(projection?.waterfall);
  return (projection?.failureFacets ?? [])
    .map((f) => {
      const ids = Array.isArray(f.eventIds) ? f.eventIds : [];
      const positions = ids.map((id) => eventPosition(id, index)).filter((p) => p != null);
      return {
        category: f.category,
        code: f.code,
        message: f.message ?? null,
        eventIds: ids,
        position: positions.length ? Math.min(...positions) : null,
      };
    })
    .filter((m) => m.position != null)
    .sort((a, b) => a.position - b.position);
}

/** 汇总 scrubber 投影（UI 一次取用） */
export function buildScrubberProjection(projection, columns = DEFAULT_COLUMNS) {
  const index = buildEventIndex(projection?.waterfall);
  const sum = (key) =>
    (projection?.waterfall ?? []).reduce((acc, t) => acc + (t[key]?.count ?? 0), 0);
  return {
    index: { floor: index.floor, len: index.len, turnSpans: index.spans },
    sparkline: buildSparkline(projection?.waterfall, columns),
    failureMarkers: buildFailureMarkers(projection),
    totals: {
      turns: (projection?.waterfall ?? []).length,
      retries: sum('retries'),
      errors: sum('errors'),
      denied: sum('denied'),
    },
  };
}
