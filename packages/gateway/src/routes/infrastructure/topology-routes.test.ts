import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';

import type { FleetTopologyGraph } from '../../fleet-topology.js';
import { registerTopologyRoutes, type TopologyRouteDependencies } from './topology-routes.js';

/**
 * `GET /topology/fleet` 的接线判据（不碰 DB：依赖全部注入）。
 *
 * 四条，每条对应一种"接口看起来对但行为错"的实现：
 *   1. **门禁真的拦得住**：拒绝时既要短路，也要**不调用读模型**（只检查状态码会漏掉"先查了再拒绝"）；
 *   2. **参数非法 = 400**，不是静默取默认值（读接口的"宽容"会让调用方以为过滤生效了）；
 *   3. 合法参数**被传下去且是数字**（JSON query 里全是字符串，忘了转就会变成 SQL 参数里的 '200'）；
 *   4. 只读投影必须 `cache-control: no-store`（与 `/cross-project/summary` 同惯例）。
 */

function fakeGraph(): FleetTopologyGraph {
  return {
    nodes: [{ id: 'gateway', kind: 'gateway', label: 'gateway', recordId: 'gateway', record: {} }],
    edges: [],
    counts: { gateway: 1, executor: 0, ssh_target: 0, placement_only: 0 },
    warnings: [],
    degraded: { isDegraded: false, reasons: [] },
    asOf: '2026-10-12T00:00:00.000Z',
    sources: [],
  };
}

function buildApp(overrides: Partial<TopologyRouteDependencies> = {}): {
  app: FastifyInstance;
  calls: Array<Parameters<TopologyRouteDependencies['readFleetTopology']>[0]>;
} {
  const calls: Array<Parameters<TopologyRouteDependencies['readFleetTopology']>[0]> = [];
  const app = Fastify({ logger: false });
  registerTopologyRoutes(app, {
    requireOperator: async () => true,
    readFleetTopology: async (options) => {
      calls.push(options);
      return fakeGraph();
    },
    ...overrides,
  });
  return { app, calls };
}

test('GET /topology/fleet 返回图，且是 no-store', async () => {
  const { app, calls } = buildApp();
  const res = await app.inject({ method: 'GET', url: '/topology/fleet' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const body = res.json() as FleetTopologyGraph;
  assert.equal(body.nodes.length, 1);
  assert.equal(body.degraded.isDegraded, false);
  assert.deepEqual(calls, [{}], '无 query 时不传任何显式上限，让读模型用自己的默认值');
  await app.close();
});

test('GET /topology/fleet 门禁拒绝时短路，且不调用读模型', async () => {
  const calls: unknown[] = [];
  const { app } = buildApp({
    requireOperator: async (_req, reply) => {
      reply.code(403).send({ error: 'operator required' });
      return false;
    },
    readFleetTopology: async (options) => {
      calls.push(options);
      return fakeGraph();
    },
  });
  const res = await app.inject({ method: 'GET', url: '/topology/fleet' });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(calls, [], '被拒绝的请求不得触碰读模型（先查再拒也是错）');
  await app.close();
});

test('GET /topology/fleet 参数非法返回 400（不静默取默认值）', async () => {
  const { app, calls } = buildApp();
  for (const url of ['/topology/fleet?nodeLimit=0', '/topology/fleet?nodeLimit=abc', '/topology/fleet?sinceHours=100000']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 400, `${url} 应 400`);
    assert.match((res.json() as { error: string }).error, /must be an integer between/);
  }
  assert.deepEqual(calls, [], '非法参数不得触发取数');
  await app.close();
});

test('GET /topology/fleet 合法参数转成数字并传下去', async () => {
  const { app, calls } = buildApp();
  const res = await app.inject({ method: 'GET', url: '/topology/fleet?sinceHours=24&nodeLimit=50&placementLimit=10&decisionLimit=20' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [{ sinceHours: 24, nodeLimit: 50, placementLimit: 10, decisionLimit: 20 }]);
  assert.equal(typeof calls[0]?.nodeLimit, 'number', '必须是数字，不能把字符串交给 SQL 参数');
  await app.close();
});
