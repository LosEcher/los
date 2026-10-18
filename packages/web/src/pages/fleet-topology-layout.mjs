/**
 * 机队拓扑的**布局投影**（纯函数：无 DOM、无 React、无 IO）。
 *
 * 为什么单独成模块：面板里真正需要被验证的不是 JSX，而是「哪台机器画在哪、显示什么数」。
 * 抽成纯 ESM 后可以直接 `node --test` 验（与 `diff-parse.mjs` / `topology-fold.mjs` 同一模式）。
 *
 * 三条不变量（每条都对应一种"图看起来对但读错了"的失败）：
 *   1. **一个节点都不能少**：输入 `nodes` 与输出 `nodes` 必须等长，差额计入 `stats.unplaced`
 *      （面板要把它显式画出来，而不是让节点静默消失）。
 *   2. **边只在两端都被放下时才画**，未画出的边进 `droppedEdges`（必须为空；非空即数据异常）。
 *   3. **确定性**：同输入两次调用坐标逐字节相同（顺序由显式排序键决定，不依赖遍历顺序）。
 *
 * 显示口径：数值一律取自服务端随图下发的 `record`，**这里不重新计算**任何指标
 * （读模型是唯一真源；面板只做投影，否则就成了第二个真相库）。
 */

// 列顺序 = 观感上的因果顺序：网关 → 能接活的执行器 → SSH 运维库存 → 仅观测到的落点。
// ⚠️ `executor` 与 `ssh_target` 必须分开：注册表里同时住着两者（实测 9 + 27），
// 混成一列会让读者以为有 36 台能接活的机器（真实数据验证时踩到过）。
export const FLEET_COLUMNS = ['gateway', 'executor', 'ssh_target', 'placement_only'];
export const FLEET_MAX_ROWS = 16;
export const FLEET_NODE_W = 150;
export const FLEET_ROW_H = 34;
export const FLEET_COL_GAP = 40;
export const FLEET_PAD = 24;
export const FLEET_MAX_LABEL_UNITS = 18;

/** 标签截断（CJK 记 2 单位）；完整名保留在 `fullLabel`，由 title/详情面板兜住。 */
export function clipLabel(label, maxUnits = FLEET_MAX_LABEL_UNITS) {
  const units = (str) => [...String(str)].reduce((a, ch) => a + (/[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1), 0);
  const text = String(label ?? '');
  if (units(text) <= maxUnits) return text;
  let out = '';
  let n = 0;
  for (const ch of text) {
    const w = /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
    if (n + w > maxUnits - 1) break;
    out += ch;
    n += w;
  }
  return `${out}…`;
}

function derivedOf(node) {
  const record = node.record ?? {};
  const placement = record.placement ?? null;
  const execution = record.execution ?? null;
  return {
    recordId: node.recordId,
    status: typeof record.status === 'string' ? record.status : null,
    hostLabel: typeof record.hostLabel === 'string' ? record.hostLabel : null,
    runs: placement?.total ?? 0,
    succeeded: placement?.succeeded ?? 0,
    failed: placement?.failed ?? 0,
    blocked: placement?.blocked ?? 0,
    lastAt: placement?.lastAt ?? null,
    candidate: execution?.candidate ?? null,
    blockers: Array.isArray(execution?.blockers) ? execution.blockers.length : 0,
    reason: typeof record.reason === 'string' ? record.reason : null,
    decision: record.decision ?? null,
  };
}

/**
 * @param {{nodes?: Array, edges?: Array}} graph `/topology/fleet` 的响应
 * @returns {{nodes: Array, edges: Array, droppedEdges: Array, columns: Array, width: number, height: number, stats: object}}
 */
export function buildFleetTopologyLayout(graph) {
  const inputNodes = graph?.nodes ?? [];
  const inputEdges = graph?.edges ?? [];

  const byColumn = new Map(FLEET_COLUMNS.map(kind => [kind, []]));
  const unknownColumn = [];
  for (const node of inputNodes) {
    const bucket = byColumn.get(node.kind);
    if (bucket) bucket.push(node);
    else unknownColumn.push(node);
  }

  // 排序键：观测量降序 → id 升序（"谁在干活"排前面；同票按 id 保证确定性）
  const decorated = new Map();
  for (const node of inputNodes) decorated.set(node.id, derivedOf(node));
  const sortKey = (a, b) => {
    const ra = decorated.get(a.id)?.runs ?? 0;
    const rb = decorated.get(b.id)?.runs ?? 0;
    if (ra !== rb) return rb - ra;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  };

  const placed = [];
  const columns = [];
  let x = FLEET_PAD;
  let maxRows = 1;
  for (const kind of FLEET_COLUMNS) {
    const list = [...byColumn.get(kind)].sort(sortKey);
    // 超过 FLEET_MAX_ROWS 时**换子列**而不是截断（少画节点是这张图最想避免的失败模式）
    const subColumns = Math.max(1, Math.ceil(list.length / FLEET_MAX_ROWS));
    maxRows = Math.max(maxRows, Math.min(list.length, FLEET_MAX_ROWS) || 1);
    columns.push({ kind, x, count: list.length, subColumns });
    list.forEach((node, index) => {
      const sub = Math.floor(index / FLEET_MAX_ROWS);
      const row = index % FLEET_MAX_ROWS;
      placed.push({
        ...node,
        x: x + sub * (FLEET_NODE_W + 12),
        y: FLEET_PAD + row * FLEET_ROW_H,
        column: kind,
        label: clipLabel(node.label ?? node.id),
        fullLabel: String(node.label ?? node.id),
        derived: decorated.get(node.id),
      });
    });
    x += subColumns * (FLEET_NODE_W + 12) + FLEET_COL_GAP;
  }
  // 未知 kind 不丢弃：排到最后一列（数据演化时宁可画得丑，也不要静默消失）
  if (unknownColumn.length > 0) {
    columns.push({ kind: 'unknown', x, count: unknownColumn.length, subColumns: 1 });
    unknownColumn.sort(sortKey).forEach((node, index) => {
      placed.push({
        ...node,
        x,
        y: FLEET_PAD + index * FLEET_ROW_H,
        column: 'unknown',
        label: clipLabel(node.label ?? node.id),
        fullLabel: String(node.label ?? node.id),
        derived: decorated.get(node.id),
      });
    });
    x += FLEET_NODE_W + 12 + FLEET_COL_GAP;
    maxRows = Math.max(maxRows, unknownColumn.length);
  }

  const idSet = new Set(placed.map(node => node.id));
  const edges = [];
  const droppedEdges = [];
  for (const edge of inputEdges) {
    if (idSet.has(edge.from) && idSet.has(edge.to)) edges.push({ ...edge });
    else droppedEdges.push({ ...edge });
  }

  return {
    nodes: placed,
    edges,
    droppedEdges,
    columns,
    width: Math.max(x - FLEET_COL_GAP + FLEET_PAD, 360),
    height: Math.max(FLEET_PAD * 2 + maxRows * FLEET_ROW_H, 120),
    stats: {
      inputNodes: inputNodes.length,
      placedNodes: placed.length,
      unplaced: inputNodes.length - placed.length,
      inputEdges: inputEdges.length,
      drawnEdges: edges.length,
      droppedEdges: droppedEdges.length,
    },
  };
}
