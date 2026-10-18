import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { foldEvidenceGraph } from './topology-fold.mjs';

/**
 * 折叠的判据（真逻辑测试，不是源码级接线断言）。
 *
 * 背景：旧实现对折叠节点做的是「从渲染集里删掉 + 用 visibleIds 双向过滤边」，
 * 于是触及它们的边**整条消失**。实测最坏情形：519 节点 / 670 边 → 渲染出 2 节点 1 边。
 * 下面的断言就是钉死"不再丢"这件事，以及归属的确定性。
 */

const node = (id, kind) => ({ id, kind, label: id, recordId: id, record: {} });
const edge = (from, to, kind, label) => (label === undefined ? { from, to, kind } : { from, to, kind, label });

/** 一个最小的、形态真实的证据图：run_spec → task_run → agent_task/attempt，事件挂在两处 */
function buildGraph() {
  return {
    nodes: [
      node('run_spec:r1', 'run_spec'),
      node('task_run:t1', 'task_run'),
      node('agent_task:a1', 'agent_task'),
      node('task_attempt:p1', 'task_attempt'),
      node('session_event:e1', 'session_event'),
      node('session_event:e2', 'session_event'),
      node('tool_call_state:c1', 'tool_call_state'),
      node('verification_record:v1', 'verification_record'),
      node('verification_record:v2', 'verification_record'),
    ],
    edges: [
      edge('run_spec:r1', 'task_run:t1', 'has_task_run'),
      edge('run_spec:r1', 'agent_task:a1', 'has_agent_task'),
      edge('agent_task:a1', 'task_attempt:p1', 'has_task_attempt'),
      edge('task_attempt:p1', 'task_run:t1', 'attempt_ran_as'),
      // e1：两个可见父（更具体的 emitted_event 应当赢）
      edge('run_spec:r1', 'session_event:e1', 'has_session_event'),
      edge('task_run:t1', 'session_event:e1', 'emitted_event'),
      // e2：只有 run_spec 这个父
      edge('run_spec:r1', 'session_event:e2', 'has_session_event'),
      // c1：attempt 用过的工具状态
      edge('task_attempt:p1', 'tool_call_state:c1', 'attempt_used_tool_state'),
      edge('run_spec:r1', 'tool_call_state:c1', 'has_tool_call_state'),
      // v1/v2：验证记录（v2 没有任何可见父 ⇒ 必须进 orphan 桶）
      edge('task_attempt:p1', 'verification_record:v1', 'attempt_verified_by'),
      // 桶内边：e1 → e2（parent_event），两端折叠后同属一个桶
      edge('session_event:e1', 'session_event:e2', 'parent_event'),
    ],
    counts: {},
  };
}

describe('foldEvidenceGraph', () => {
  it('没有任何边的端点不在节点集里（旧实现的核心缺陷）', () => {
    const out = foldEvidenceGraph(buildGraph());
    const ids = new Set(out.nodes.map(n => n.id));
    for (const e of out.edges) {
      assert.ok(ids.has(e.from), `悬空 from: ${e.from}`);
      assert.ok(ids.has(e.to), `悬空 to: ${e.to}`);
    }
  });

  it('折叠成员一个都不丢：全部归入某个桶且可追溯', () => {
    const graph = buildGraph();
    const out = foldEvidenceGraph(graph);
    const foldedIds = graph.nodes.filter(n => ['session_event', 'tool_call_state', 'verification_record'].includes(n.kind)).map(n => n.id);
    const collected = out.nodes.filter(n => n.kind === 'folded').flatMap(n => n.record.memberIds);
    assert.deepEqual([...collected].sort(), [...foldedIds].sort(), '成员集合必须与折叠集合逐一对应');
    for (const id of foldedIds) assert.ok(!out.nodes.some(n => n.id === id), '折叠成员不得作为独立节点出现');
  });

  it('归属按优先级确定性选择：emitted_event 胜过 has_session_event', () => {
    const out = foldEvidenceGraph(buildGraph());
    const groups = out.nodes.filter(n => n.kind === 'folded');
    const eventGroup = groups.find(g => g.record.memberIds.includes('session_event:e1'));
    assert.equal(eventGroup.record.owner, 'task_run:t1', '更具体的 emitted_event 应决定归属');
    const e2Group = groups.find(g => g.record.memberIds.includes('session_event:e2'));
    assert.equal(e2Group.record.owner, 'run_spec:r1');
  });

  it('没有可见父的成员进 orphan 桶，而不是被丢掉', () => {
    const out = foldEvidenceGraph(buildGraph());
    const orphan = out.nodes.find(n => n.kind === 'folded' && n.record.owner === null);
    assert.ok(orphan, 'orphan 桶必须存在');
    assert.deepEqual(orphan.record.memberIds, ['verification_record:v2']);
  });

  it('触及成员的边被重写成指向桶，且原始 kind 保留在 label 上', () => {
    const out = foldEvidenceGraph(buildGraph());
    const rewritten = out.edges.filter(e => e.kind === 'folded');
    assert.ok(rewritten.length > 0);
    for (const e of rewritten) assert.ok(e.label, '重写后的边必须保留原始 kind');
    const labels = rewritten.map(e => e.label);
    assert.ok(labels.includes('emitted_event'), 'emitted_event 必须被重写保留');
    assert.ok(labels.includes('has_session_event'));
    // 可见→成员 重写后必须从可见端出发
    const fromVisible = rewritten.find(e => e.label === 'has_session_event');
    assert.equal(fromVisible.from, 'run_spec:r1');
    assert.match(fromVisible.to, /^fold:/);
  });

  it('桶内边消失但计数可见；跨桶边不丢（标成 folded 桶间边）', () => {
    const out = foldEvidenceGraph(buildGraph());
    // e1→e2 都是 session_event 且同属 task_run:t1 桶？e1 归 t1、e2 归 r1 ⇒ 跨桶
    assert.ok(out.stats.crossGroupEdges >= 1, '跨桶边必须被记账为 folded 边而不是丢弃');
    const cross = out.edges.filter(e => e.kind === 'folded' && e.from.startsWith('fold:') && e.to.startsWith('fold:'));
    assert.equal(cross.length, out.stats.crossGroupEdges);
    assert.equal(typeof out.stats.internalEdgesDropped, 'number');
    // 若两端同桶则丢一条：
    const same = foldEvidenceGraph({
      nodes: [node('run_spec:r1', 'run_spec'), node('session_event:e1', 'session_event'), node('session_event:e2', 'session_event')],
      edges: [
        edge('run_spec:r1', 'session_event:e1', 'has_session_event'),
        edge('run_spec:r1', 'session_event:e2', 'has_session_event'),
        edge('session_event:e1', 'session_event:e2', 'parent_event'),
      ],
    });
    assert.equal(same.stats.internalEdgesDropped, 1, '同桶内边必须被记为"已丢弃"');
    assert.equal(same.stats.groups, 1);
  });

  it('逐边性质：触及成员的边要么被重写、要么被记为桶内消失，绝不静默不见', () => {
    const graph = buildGraph();
    const out = foldEvidenceGraph(graph);
    const foldedKinds = ['session_event', 'tool_call_state', 'verification_record'];
    const foldedIds = new Set(graph.nodes.filter(n => foldedKinds.includes(n.kind)).map(n => n.id));
    const outIds = new Set(out.nodes.map(n => n.id));

    for (const original of graph.edges) {
      const touches = foldedIds.has(original.from) || foldedIds.has(original.to);
      if (!touches) {
        // 未触及的边必须原样在
        assert.ok(
          out.edges.some(e => e.from === original.from && e.to === original.to && e.kind === original.kind),
          `未触及的边丢失: ${original.from}->${original.to}`,
        );
        continue;
      }
      // 触及的边：存在一条同 label（原始 kind）的输出边，且其端点都在图上
      const rewritten = out.edges.find(e => e.label === original.kind);
      const droppedAsInternal = !rewritten;
      assert.ok(
        rewritten || out.stats.internalEdgesDropped > 0,
        `触及成员的边既没被重写也没被记为桶内消失: ${original.kind}`,
      );
      if (rewritten) {
        assert.ok(outIds.has(rewritten.from) && outIds.has(rewritten.to), '重写后的端点必须在图上');
      }
      void droppedAsInternal;
    }

    // 记账闭合：触及成员的边 = 重写 + 去重合并 + 桶内消失
    assert.equal(
      out.stats.memberTouchedEdges,
      out.stats.rewrittenEdges + out.stats.dedupedRewrites + out.stats.internalEdgesDropped,
      '触及成员的边必须逐条有归属',
    );
  });

  it('幂等：对已折叠的图再折叠是 no-op', () => {
    const once = foldEvidenceGraph(buildGraph());
    const twice = foldEvidenceGraph(once);
    assert.equal(twice.nodes.length, once.nodes.length);
    assert.equal(twice.edges.length, once.edges.length);
    assert.equal(twice.stats.foldedNodes, 0);
  });

  it('没有可折叠 kind 时原样返回', () => {
    const plain = { nodes: [node('a', 'run_spec'), node('b', 'task_run')], edges: [edge('a', 'b', 'has_task_run')] };
    const out = foldEvidenceGraph(plain);
    assert.deepEqual(out.nodes.map(n => n.id), ['a', 'b']);
    assert.deepEqual(out.edges, plain.edges);
    assert.equal(out.stats.foldedNodes, 0);
  });
});
