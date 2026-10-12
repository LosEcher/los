/**
 * 证据图的**折叠**（纯函数，无 DOM / 无 React）。
 *
 * 为什么单独成模块：折叠是这张图里唯一有真实算法的地方（归组 + 边重写），
 * 而它此前是内联在组件里的「按层号过滤节点」——规则不可测，缺陷也看不见。
 * 抽成纯 ESM 后可以直接用 `node --test` 验（与 `diff-parse.mjs` 同一模式）。
 *
 * ## 它修的是什么
 * 旧实现对 `session_event` / `tool_call_state` / `verification_record` 做的是
 * **把节点从渲染集里删掉**，同时把触及它们的边整条丢掉（只用 `visibleIds` 做双向过滤），
 * 于是「哪个 task_run 产生了这些事件」这层关系**静默消失**。
 * 实测最坏情形：519 节点 / 670 边的证据图渲染后只剩 **2 个节点 + 1 条边**。
 *
 * 本模块的规则（每条都对应一个失败模式）：
 *   1. **折叠 = 归组，不是删除**：被折叠的节点按其「所属可见父」归入若干个**桶**，
 *      桶本身作为节点参与渲染。成员一个都不会消失（`memberIds` 可追溯）。
 *   2. **触及成员的边必须重写，不能丢**：可见→成员 重写成 可见→桶；
 *      成员→可见 重写成 桶→可见；跨桶的成员→成员 重写成 桶→桶；
 *      只有**桶内**的边才消失，且消失数量计入 `stats.internalEdgesDropped`（可观测）。
 *   3. **归属必须确定性**：按边 kind 的优先级（`emitted_event` 比 `has_session_event` 更具体）
 *      再按源 id 字典序，绝不依赖遍历顺序；找不到可见父的成员进 `orphan` 桶（而不是被丢掉）。
 *   4. **折叠幂等**：对已折叠的图再折叠一次应原样返回（折叠节点不再被折叠）。
 */

export const DEFAULT_FOLD_KINDS = ['session_event', 'tool_call_state', 'verification_record'];

/** 归属优先级：越具体的边越能说明「这个成员属于谁」。 */
const OWNER_PRIORITY = {
  session_event: ['emitted_event', 'has_session_event'],
  tool_call_state: ['attempt_used_tool_state', 'has_tool_call_state'],
  verification_record: ['attempt_verified_by', 'has_verification_record'],
};

const FOLD_NODE_KIND = 'folded';

function priorityOf(foldedKind, edgeKind) {
  const list = OWNER_PRIORITY[foldedKind] ?? [];
  const index = list.indexOf(edgeKind);
  return index === -1 ? list.length + 1 : index;
}

/**
 * @param {{nodes: Array, edges: Array}} graph 证据图（`RuntimeEvidenceGraph` 的形状即可）
 * @param {{foldKinds?: string[]}} [options]
 * @returns {{nodes: Array, edges: Array, stats: object, foldedMemberIds: string[]}}
 */
export function foldEvidenceGraph(graph, options = {}) {
  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  const foldKinds = new Set(options.foldKinds ?? DEFAULT_FOLD_KINDS);

  const folded = nodes.filter(node => foldKinds.has(node.kind));
  const visible = nodes.filter(node => !foldKinds.has(node.kind));

  // 无折叠对象：原样返回（也保证幂等——已折叠的图里没有这些 kind）
  if (folded.length === 0) {
    return {
      nodes: [...visible],
      edges: [...edges],
      stats: { foldedNodes: 0, groups: 0, rewrittenEdges: 0, internalEdgesDropped: 0, crossGroupEdges: 0, keptEdges: edges.length },
      foldedMemberIds: [],
    };
  }

  const visibleIds = new Set(visible.map(node => node.id));
  const foldedIds = new Set(folded.map(node => node.id));

  // ── 1. 归属：确定性选出每个成员的可见父 ────────────────────────────────────
  const bestOwner = new Map(); // foldedId -> { ownerId, rank }
  for (const edge of edges) {
    if (!foldedIds.has(edge.to) || !visibleIds.has(edge.from)) continue;
    const foldedKind = folded.find(node => node.id === edge.to)?.kind ?? '';
    const rank = priorityOf(foldedKind, edge.kind);
    const current = bestOwner.get(edge.to);
    if (!current || rank < current.rank || (rank === current.rank && edge.from < current.ownerId)) {
      bestOwner.set(edge.to, { ownerId: edge.from, rank });
    }
  }

  const groupKeyOf = (foldedId) => {
    const node = folded.find(item => item.id === foldedId);
    const owner = bestOwner.get(foldedId)?.ownerId ?? null;
    return `${node?.kind ?? 'unknown'}|${owner ?? ''}`;
  };
  const groupIdOf = (key) => `fold:${key}`;
  const groupIdByMember = new Map();
  for (const node of folded) groupIdByMember.set(node.id, groupIdOf(groupKeyOf(node.id)));

  // ── 2. 桶节点 ──────────────────────────────────────────────────────────────
  const groups = new Map(); // groupId -> group
  for (const node of folded) {
    const key = groupKeyOf(node.id);
    const id = groupIdOf(key);
    if (!groups.has(id)) {
      groups.set(id, {
        id,
        kind: FOLD_NODE_KIND,
        label: '',
        recordId: id,
        record: {
          foldedKind: node.kind,
          owner: bestOwner.get(node.id)?.ownerId ?? null,
          memberIds: [],
          memberKinds: {},
        },
      });
    }
    const group = groups.get(id);
    group.record.memberIds.push(node.id);
    group.record.memberKinds[node.kind] = (group.record.memberKinds[node.kind] ?? 0) + 1;
  }
  for (const group of groups.values()) {
    const kinds = Object.entries(group.record.memberKinds)
      .map(([kind, n]) => `${kind}×${n}`)
      .join(' ');
    group.label = `▣ ${kinds}`;
    group.record.count = group.record.memberIds.length;
    group.record.memberIds.sort();
  }

  // ── 3. 边重写（触及成员的边一律改指到桶；只有桶内边消失） ──────────────────
  const outEdges = [];
  const seen = new Set();
  const push = (from, to, kind, label) => {
    const key = `${from}|${kind}|${to}|${label ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    outEdges.push(label === undefined ? { from, to, kind } : { from, to, kind, label });
  };
  const stats = {
    foldedNodes: folded.length,
    groups: groups.size,
    /** 原始边里**触及至少一个折叠成员**的条数（下面三项之和应等于它） */
    memberTouchedEdges: 0,
    rewrittenEdges: 0,
    /** 重写后因 (from,kind,to,label) 相同而被合并掉的条数（去重，不是丢失） */
    dedupedRewrites: 0,
    internalEdgesDropped: 0,
    crossGroupEdges: 0,
    keptEdges: 0,
  };

  for (const edge of edges) {
    const fromFolded = foldedIds.has(edge.from);
    const toFolded = foldedIds.has(edge.to);
    if (!fromFolded && !toFolded) {
      push(edge.from, edge.to, edge.kind, edge.label);
      stats.keptEdges += 1;
      continue;
    }
    const fromGroup = fromFolded ? groupIdByMember.get(edge.from) : edge.from;
    const toGroup = toFolded ? groupIdByMember.get(edge.to) : edge.to;
    stats.memberTouchedEdges += 1;
    if (fromGroup === toGroup) {
      // 桶内边：折叠后两端合一，消失——但**计数必须可见**
      stats.internalEdgesDropped += 1;
      continue;
    }
    if (fromFolded && toFolded) stats.crossGroupEdges += 1;
    // 原始 kind 保留在 label 上（重写不等于篡改语义）
    const before = outEdges.length;
    push(fromGroup, toGroup, FOLD_NODE_KIND, edge.kind);
    if (outEdges.length === before) stats.dedupedRewrites += 1;
    else stats.rewrittenEdges += 1;
  }

  return {
    nodes: [...visible, ...groups.values()],
    edges: outEdges,
    stats,
    foldedMemberIds: folded.map(node => node.id),
  };
}
