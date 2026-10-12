import test from 'node:test';
import assert from 'node:assert/strict';

import { closeDb, getDb, initDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import { ensureExecutorNodeStore, upsertExecutorNode } from '@los/agent/executor-nodes';
import { ensureTaskRunStore } from '@los/agent/task-runs';
import { ensureSchedulerDecisionLedgerStore } from '@los/agent';
import { readFleetTopology } from './fleet-topology.js';

/**
 * 机队拓扑读模型的判据（DB 支撑；schema 由 gateway 的 test-setup 准备）。
 *
 * 这个读模型的价值全在**分类与诚实性**上，所以判据也压在这两处：
 *   · 声明（注册表）与观测（`task_runs.node_id`）必须分开表达，注册了但没跑过**不画边**；
 *   · 只出现在观测里的落点必须被标出来并带上原因（gateway-local / unregistered / url-like）；
 *   · 截断必须进 `degraded`，不是静默少给数据。
 *
 * 不判据几何（本面不下发 x/y），也不判据节点健康（那是 `/nodes/health` 的职责）。
 */

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const nodeIds: string[] = [];
const taskRunIds: string[] = [];
const decisionIds: string[] = [];

/** 最小可用的注册节点（只填读模型真正会读的字段；其余走默认值） */
function executorInput(nodeId: string) {
  return {
    nodeId,
    nodeKind: 'executor' as const,
    baseUrl: `http://127.0.0.1:9${Math.floor(Math.random() * 900) + 100}`,
    hostLabel: `host-${nodeId}`,
    status: 'online' as const,
    version: '0.0.0-test',
    targetVersion: '0.0.0-test',
    rolloutState: 'idle' as const,
    connectModes: ['agent_http' as const],
    connectConfig: {},
    // capacity 按**实测字段**给（camelCase）：读模型的白名单必须与 `/nodes` 对齐、不得丢库里的键
    capacity: {
      pid: 1234, platform: 'darwin', arch: 'arm64', cpuCores: 10, cpuModel: 'Apple M1 Pro',
      cpuLoad1m: 1.25, kernelVersion: 'Darwin 25.5.0', sampledAt: '2026-10-12T00:00:00.000Z',
      memoryTotalMb: 32768, memoryAvailableMb: 20644, swapTotalMb: 2048, swapUsedMb: 128,
      psiIoFull: 0, psiMemoryFull: 0,
    },
    capabilities: { sandbox: 'macos-sandbox-exec', run_agent: true, resourceClass: 'standard_executor' },
    queueDepth: 0,
    activeTaskCount: 0,
  };
}

async function insertTaskRun(id: string, nodeId: string | null, status: string, createdAt: string): Promise<void> {
  taskRunIds.push(id);
  await getDb().query(
    `INSERT INTO task_runs (id, session_id, node_id, workspace_root, tool_mode, status, created_at)
     VALUES ($1, $2, $3, $4, 'read-only', $5, $6)`,
    [id, `sess-${suffix}`, nodeId, '/tmp/ws', status, createdAt],
  );
}

/** 直接写库：调度台账的写入有校验，测试要造"类型外的历史行"只能绕过它 */
async function insertDecision(id: string, kind: string, nodeId: string | null, createdAt: string): Promise<void> {
  decisionIds.push(id);
  await getDb().query(
    `INSERT INTO scheduler_decisions (id, graph_id, node_id, kind, reason, selected_ids_json, created_at)
     VALUES ($1, $2, $3, $4, 'test', $5::jsonb, $6)`,
    [id, `graph-${suffix}`, nodeId, kind, JSON.stringify(nodeId ? [nodeId] : []), createdAt],
  );
}

async function cleanup(): Promise<void> {
  for (const id of decisionIds) await getDb().query('DELETE FROM scheduler_decisions WHERE id = $1', [id]);
  decisionIds.length = 0;
  for (const id of taskRunIds) await getDb().query('DELETE FROM task_runs WHERE id = $1', [id]);
  for (const id of nodeIds) await getDb().query('DELETE FROM executor_nodes WHERE node_id = $1', [id]);
  taskRunIds.length = 0;
  nodeIds.length = 0;
}

test('fleet topology: 声明与观测分开、落点分类带原因、截断进 degraded', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  try {
    await ensureExecutorNodeStore();
    await ensureTaskRunStore();
    await ensureSchedulerDecisionLedgerStore();
    const now = new Date();
    const at = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000).toISOString();

    // 两个注册节点：一个真的跑过、一个只是登记着（负向控制：不许画边）
    const used = `topo-used-${suffix}`;
    const idle = `topo-idle-${suffix}`;
    // SSH 运维库存：`nodeKind='ssh_target'` —— 它**不是**执行器，必须单独成类
    const sshOnly = `topo-ssh-${suffix}`;
    for (const id of [used, idle]) {
      nodeIds.push(id);
      await upsertExecutorNode(executorInput(id));
    }
    nodeIds.push(sshOnly);
    await upsertExecutorNode({ ...executorInput(sshOnly), nodeKind: 'ssh_target', baseUrl: undefined, status: 'offline' });
    await insertTaskRun(`tr-${suffix}-1`, used, 'succeeded', at(30));
    await insertTaskRun(`tr-${suffix}-2`, used, 'failed', at(20));
    await insertTaskRun(`tr-${suffix}-3`, null, 'succeeded', at(20));
    await insertTaskRun(`tr-${suffix}-4`, 'gateway-local', 'succeeded', at(10));
    await insertTaskRun(`tr-${suffix}-5`, 'http://100.0.0.1:8090', 'blocked', at(10));
    // 决策：3 条正常 + 1 条**类型外**（kindRaw 保留，用于验证"类型外 kind 必须被看见"）
    await insertDecision(`dec-${suffix}-1`, 'executor_selection', used, at(9));
    await insertDecision(`dec-${suffix}-2`, 'executor_selection', used, at(8));
    await insertDecision(`dec-${suffix}-3`, 'executor_selection', idle, at(7));
    await insertDecision(`dec-${suffix}-4`, 'placement_decision', null, at(6));
    // 合法邻居 kind：**不得**被告警（负向控制——第一版把它误报成"非预期 kind"）
    await insertDecision(`dec-${suffix}-5`, 'task_outcome', null, at(5));

    // decisionLimit=2 ⇒ 窗口内必有截断（确定性，不依赖环境里的既有数据）
    const graph = await readFleetTopology({ sinceHours: 24, nodeLimit: 500, placementLimit: 100, decisionLimit: 2 });

    const byId = new Map(graph.nodes.map(n => [n.id, n]));
    const usedNode = byId.get(used);
    const idleNode = byId.get(idle);
    assert.ok(usedNode, '注册节点必须在图上');
    assert.ok(idleNode, '只登记没跑过的节点也必须在图上（它是声明，不是观测）');
    assert.equal((usedNode.record as { placement?: { total?: number } }).placement?.total, 2, '观测量必须来自 task_runs');
    assert.equal((idleNode.record as { placement?: unknown }).placement, null, '没跑过就没有观测量');

    // 边 = 观测：只有真的跑过的落点才有边
    const targets = graph.edges.map(e => e.to);
    assert.ok(targets.includes(used), '跑过的注册节点必须有边');
    assert.ok(!targets.includes(idle), '只登记没跑过的节点不得有边（注册 ≠ 在用）');
    assert.ok(graph.edges.every(e => e.from === 'gateway' && e.kind === 'dispatch'));

    // 只出现在观测里的落点：分类 + 原因
    const reasons = new Map(graph.nodes.filter(n => n.kind === 'placement_only').map(n => [n.label, (n.record as { reason: string }).reason]));
    assert.equal(reasons.get('gateway-local'), 'gateway-local');
    assert.equal(reasons.get('http://100.0.0.1:8090'), 'url-like', 'URL 污染必须显式标出来，不许归一化抹掉');
    assert.equal(reasons.get('(no node_id)'), 'missing-node-id');

    // gateway 节点自带本地落点（它不在注册表里）
    const gatewayNode = byId.get('gateway');
    assert.ok(gatewayNode);
    assert.ok((gatewayNode.record as { localPlacement?: unknown }).localPlacement, 'gateway-local 的观测量必须挂在网关节点上');

    // counts 自洽
    assert.equal(Object.values(graph.counts).reduce((a, b) => a + b, 0), graph.nodes.length);

    // capacity 白名单必须与 `/nodes` 对齐：库里给什么键，读模型就得给出什么键（不得静默少给）
    const capacity = (usedNode.record as { capacity?: Record<string, unknown> }).capacity ?? {};
    for (const key of ['pid', 'platform', 'arch', 'cpuCores', 'cpuModel', 'cpuLoad1m', 'kernelVersion',
      'sampledAt', 'memoryTotalMb', 'memoryAvailableMb', 'swapTotalMb', 'swapUsedMb', 'psiIoFull', 'psiMemoryFull']) {
      assert.equal(capacity[key] !== null && capacity[key] !== undefined, true, `capacity.${key} 不得缺失（与 /nodes 对齐）`);
    }
    // 实测从未采集的键：读模型**不假装**有值（null，而不是编一个数）
    assert.equal(capacity.diskFreeGb, null, 'diskFreeGb 无人采集 ⇒ 必须如实为 null');

    // 注册表里两类节点必须分开（实测教训：混为一谈会让图声称"36 个执行器"而真正能接活的只有 9 个）
    assert.equal(byId.get(sshOnly)?.kind, 'ssh_target', 'ssh_target 不得被标成 executor');
    assert.equal((usedNode.record as { nodeKind?: string }).nodeKind, 'executor');
    assert.ok((graph.counts.ssh_target ?? 0) >= 1, 'counts 必须单列 ssh_target');
    assert.ok(!graph.edges.some(e => e.to === sshOnly), 'ssh_target 不是执行面，不应有 dispatch 边');

    // 截断 → degraded（decisionLimit=5 而窗口内决策远多于 5）
    assert.equal(graph.degraded.isDegraded, true, '决策窗口被截必须进 degraded');
    assert.ok(graph.degraded.reasons.some(r => /decisions truncated/.test(r)), `原因须指名截断：${graph.degraded.reasons.join('|')}`);
    assert.ok(
      graph.degraded.reasons.some(r => /placement_decision/.test(r)),
      `闭集外的 kind 必须被看见（"读路径容忍"不等于"没人管"）：${graph.degraded.reasons.join('|')}`,
    );
    assert.ok(
      !graph.degraded.reasons.some(r => /kind=task_outcome/.test(r)),
      `合法的邻居 kind 不得告警（假警报会把通道训练成噪音）：${graph.degraded.reasons.join('|')}`,
    );
    assert.deepEqual(graph.degraded.reasons, graph.warnings, 'reasons 是 warnings 的子集（今天是全部）');

    // sources 必须写明三个面
    assert.deepEqual(graph.sources.map(s => s.id), ['executor_nodes', 'task_runs', 'scheduler_decisions']);

    // 松散上限也要能触发落点截断（placementLimit=1 时窗口内有多个落点）
    const capped = await readFleetTopology({ sinceHours: 24, nodeLimit: 500, placementLimit: 1, decisionLimit: 5 });
    assert.equal(capped.degraded.isDegraded, true);
    assert.ok(capped.degraded.reasons.some(r => /placement truncated/.test(r)), '落点截断必须自报');
  } finally {
    await cleanup();
    await closeDb();
  }
});
