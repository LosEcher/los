import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FLEET_MAX_ROWS,
  FLEET_NODE_W,
  buildFleetTopologyLayout,
  clipLabel,
} from './fleet-topology-layout.mjs';

/**
 * 机队拓扑布局投影的判据。
 *
 * 这里钉的是「一个节点都不能少 / 边不静默消失 / 指标只读服务端的数」——
 * 面板的 JSX 无法被这些断言覆盖，所以真正需要保护的逻辑必须留在纯模块里。
 */

const node = (id, kind, record = {}, label = id) => ({ id, kind, label, recordId: id, record });
const edge = (from, to, label) => ({ from, to, kind: 'dispatch', label });

function sampleGraph() {
  return {
    nodes: [
      node('gateway', 'gateway', { localPlacement: { total: 73 } }),
      node('mbp', 'executor', { status: 'online', placement: { total: 370, succeeded: 300, failed: 20, blocked: 50 }, execution: { candidate: true, blockers: [] } }, 'Echers-Mbp.local'),
      node('m3', 'executor', { status: 'offline', placement: { total: 17 }, execution: { candidate: false, blockers: ['heartbeat:stale'] } }, 'los的MacBook Pro'),
      node('ssh-inv-1', 'ssh_target', { status: 'offline' }, 'hh-sgp1-r-t'),
      node('placement:node-2', 'placement_only', { reason: 'unregistered', placement: { total: 15 } }, 'node-2'),
    ],
    edges: [edge('gateway', 'mbp', '370 次'), edge('gateway', 'm3', '17 次'), edge('gateway', 'placement:node-2', '15 次')],
  };
}

describe('buildFleetTopologyLayout', () => {
  it('三类节点分列，列 x 递增', () => {
    const out = buildFleetTopologyLayout(sampleGraph());
    const cols = new Map(out.columns.map(c => [c.kind, c.x]));
    assert.ok(cols.get('gateway') < cols.get('executor'), 'gateway 列在 executor 之前');
    assert.ok(cols.get('executor') < cols.get('ssh_target'), '执行器列在运维库存之前');
    assert.ok(cols.get('ssh_target') < cols.get('placement_only'));
    const byId = new Map(out.nodes.map(n => [n.id, n]));
    assert.equal(byId.get('gateway').column, 'gateway');
    assert.equal(byId.get('mbp').column, 'executor');
    assert.equal(byId.get('placement:node-2').column, 'placement_only');
    // 注册表里两类节点不得同列（真实数据验证时踩到过：27 个运维库存被当成了执行器）
    assert.equal(byId.get('ssh-inv-1').column, 'ssh_target');
    assert.notEqual(byId.get('ssh-inv-1').column, byId.get('mbp').column);
  });

  it('一个节点都不少（unplaced 必须为 0）', () => {
    const graph = sampleGraph();
    const out = buildFleetTopologyLayout(graph);
    assert.equal(out.stats.inputNodes, graph.nodes.length);
    assert.equal(out.stats.placedNodes, graph.nodes.length);
    assert.equal(out.stats.unplaced, 0);
  });

  it('超过单列上限时换子列而不是截断', () => {
    const nodes = [node('gateway', 'gateway')];
    for (let i = 0; i < FLEET_MAX_ROWS + 3; i += 1) {
      nodes.push(node(`exec-${i}`, 'executor', { placement: { total: 100 - i } }));
    }
    const out = buildFleetTopologyLayout({ nodes, edges: [] });
    assert.equal(out.stats.unplaced, 0, '换列不得丢节点');
    const executorCol = out.columns.find(c => c.kind === 'executor');
    assert.equal(executorCol.subColumns, 2, `${FLEET_MAX_ROWS + 3} 个执行节点应占 2 个子列`);
    const execXs = new Set(out.nodes.filter(n => n.kind === 'executor').map(n => n.x));
    assert.equal(execXs.size, 2, '子列各有自己的 x');
    assert.ok([...execXs].some(x => x > executorCol.x), '第二个子列必须右移');
  });

  it('确定性：同输入两次调用坐标完全一致', () => {
    const a = buildFleetTopologyLayout(sampleGraph());
    const b = buildFleetTopologyLayout(sampleGraph());
    assert.deepEqual(a.nodes, b.nodes);
  });

  it('列内按观测量降序，同票按 id 升序', () => {
    const out = buildFleetTopologyLayout({
      nodes: [
        node('a', 'executor', { placement: { total: 5 } }),
        node('b', 'executor', { placement: { total: 90 } }),
        node('c', 'executor', { placement: { total: 5 } }),
      ],
      edges: [],
    });
    const ids = out.nodes.filter(n => n.kind === 'executor').map(n => n.id);
    assert.deepEqual(ids, ['b', 'a', 'c'], '观测量大的在前；同票按 id');
  });

  it('指标只读服务端下发的 record，不在这里重算', () => {
    const out = buildFleetTopologyLayout(sampleGraph());
    const mbp = out.nodes.find(n => n.id === 'mbp');
    assert.equal(mbp.derived.runs, 370);
    assert.equal(mbp.derived.succeeded, 300);
    assert.equal(mbp.derived.failed, 20);
    assert.equal(mbp.derived.blocked, 50);
    const m3 = out.nodes.find(n => n.id === 'm3');
    assert.equal(m3.derived.candidate, false);
    assert.equal(m3.derived.blockers, 1);
    assert.equal(m3.derived.status, 'offline');
  });

  it('未知 kind 不丢弃，排到最后一列', () => {
    const out = buildFleetTopologyLayout({
      nodes: [node('gateway', 'gateway'), node('weird', 'brand_new_kind')],
      edges: [],
    });
    assert.equal(out.stats.unplaced, 0);
    assert.equal(out.nodes.find(n => n.id === 'weird').column, 'unknown');
    assert.ok(out.columns.some(c => c.kind === 'unknown'));
  });

  it('边只在两端都被放下时画出；未画出的一律进 droppedEdges', () => {
    const out = buildFleetTopologyLayout(sampleGraph());
    const ids = new Set(out.nodes.map(n => n.id));
    for (const e of out.edges) {
      assert.ok(ids.has(e.from) && ids.has(e.to), `悬空边: ${e.from}->${e.to}`);
    }
    assert.equal(out.stats.drawnEdges, out.edges.length);
    assert.equal(out.stats.droppedEdges, out.droppedEdges.length);
    assert.equal(out.stats.droppedEdges + out.stats.drawnEdges, out.stats.inputEdges, '边数必须记账闭合');
  });

  it('空图不崩且给出下限尺寸', () => {
    const out = buildFleetTopologyLayout({});
    assert.deepEqual(out.nodes, []);
    assert.deepEqual(out.edges, []);
    assert.ok(out.width >= 360 && out.height >= 120);
    assert.equal(out.stats.inputNodes, 0);
  });

  it('标签截断保留完整名（CJK 按 2 单位）', () => {
    assert.equal(clipLabel('short'), 'short');
    const clipped = clipLabel('los的MacBook-Pro-非常长的机器名');
    assert.notEqual(clipped, 'los的MacBook-Pro-非常长的机器名');
    assert.ok(clipped.endsWith('…'));
    const out = buildFleetTopologyLayout({
      nodes: [node('m3', 'executor', {}, 'los的MacBook-Pro-非常长的机器名')],
      edges: [],
    });
    assert.equal(out.nodes[0].fullLabel, 'los的MacBook-Pro-非常长的机器名', '完整名必须保留');
    assert.ok([...out.nodes[0].label].length < [...out.nodes[0].fullLabel].length);
  });
});
