import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { loadConfig } from '@los/infra/config';
import { closeDb, initDb } from '@los/infra/db';

import { registerRequestContext } from '../request-context.js';
import { registerNodeRoutes, type NodeRouteDependencies } from './infrastructure/node-routes.js';
import { registerTaskRoutes, type TaskRouteDependencies } from './orchestration/task-routes.js';

/**
 * 有界查询参数（`limit`）的**跨路由行为契约**。
 *
 * 为什么单开一个文件：这里测的不是某个模块，而是**同一类参数在所有路由上的同一种行为**——
 * 而"同类参数行为不一致"正是最容易悄悄发生的事（本仓实测：
 * `?limit=` 在有的路由被夹取、有的固定死、有的报 400）。
 *
 * 约定（新增的有界参数一律如此）：
 *   · 缺省 ⇒ 交给路由自己的默认值（`/nodes`、`/tasks` 都是 50，保持既有调用方行为）；
 *   · 非法（非整数 / 越界）⇒ **400 且指名参数与范围**，不静默夹取、不静默用默认值；
 *   · 非法请求**不得触发取数**（先校验再查库）。
 *
 * 依赖用注入的假件；被 mock 的只有资源边界（store 与查询函数），路由的解析逻辑走真码。
 * `/tasks` 走 `resolveReadScope(req)`（它不在可注入的 deps 里）⇒ 必须注册请求上下文，
 * 因此本文件是 DB 支撑的（isolated 组）。
 */
async function buildApp(register: (app: ReturnType<typeof Fastify>) => void) {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const app = Fastify({ logger: false });
  registerRequestContext(app, config);
  register(app);
  return app;
}

function fakeNodeDeps(calls: number[]): NodeRouteDependencies {
  return {
    requireOperator: async () => true,
    ensureExecutorNodeStore: async () => {},
    listExecutorNodes: async (limit?: number) => {
      calls.push(limit ?? -1);
      return [];
    },
  } as unknown as NodeRouteDependencies;
}

function fakeTaskDeps(calls: Array<number | undefined>): TaskRouteDependencies {
  return {
    ensureTaskRunStore: async () => {},
    listTaskRuns: async (limit?: number) => {
      calls.push(limit);
      return [];
    },
  } as unknown as TaskRouteDependencies;
}

test('/nodes 的 limit：缺省 50、合法透传、非法 400 且不取数', async () => {
  const calls: number[] = [];
  const app = await buildApp(a => registerNodeRoutes(a, fakeNodeDeps(calls)));

  assert.equal((await app.inject({ method: 'GET', url: '/nodes' })).statusCode, 200);
  assert.deepEqual(calls, [50], '缺省必须保持既有行为（50）');

  assert.equal((await app.inject({ method: 'GET', url: '/nodes?limit=7' })).statusCode, 200);
  assert.deepEqual(calls, [50, 7], '合法 limit 必须透传（且是数字）');

  for (const bad of ['0', 'abc', '501', '1.5']) {
    const res = await app.inject({ method: 'GET', url: `/nodes?limit=${bad}` });
    assert.equal(res.statusCode, 400, `limit=${bad} 必须 400，不得静默夹取`);
    assert.match((res.json() as { error: string }).error, /limit must be an integer between 1 and 500/);
  }
  assert.deepEqual(calls, [50, 7], '非法请求不得触发取数');
  await app.close();
  await closeDb();
});

test('/tasks 的 limit：缺省 50、合法透传、非法 400 且不取数', async () => {
  const calls: Array<number | undefined> = [];
  const app = await buildApp(a => registerTaskRoutes(a, fakeTaskDeps(calls)));

  assert.equal((await app.inject({ method: 'GET', url: '/tasks' })).statusCode, 200);
  assert.deepEqual(calls, [50], '缺省必须保持既有行为（50）');

  assert.equal((await app.inject({ method: 'GET', url: '/tasks?limit=3' })).statusCode, 200);
  assert.deepEqual(calls, [50, 3]);

  for (const bad of ['0', 'abc', '501']) {
    const res = await app.inject({ method: 'GET', url: `/tasks?limit=${bad}` });
    assert.equal(res.statusCode, 400, `limit=${bad} 必须 400`);
  }
  assert.deepEqual(calls, [50, 3], '非法请求不得触发取数');
  await app.close();
  await closeDb();
});
