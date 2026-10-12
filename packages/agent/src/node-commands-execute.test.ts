import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';

import { ensureExecutorNodeStore, upsertExecutorNode } from './executor-nodes.js';
import { ensureNodeCommandStore, executeNodeCommand } from './node-commands.js';

/**
 * 路径级测试（2026-10-11 教训）：`executeNodeCommand` 内每个命令都必须**显式**分支，
 * 否则落到末尾的默认拒绝。上一轮只测了 executor 侧的 runtime 处理器（接缝），
 * 于是 `run-check` 在真实路径上被默认拒绝挡下——真机 smoke 才发现。
 */
test('executeNodeCommand routes run-check to the node runtime, not the default deny', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const nodeId = `node-run-check-${Date.now()}`;
  try {
    await ensureNodeCommandStore();
    await ensureExecutorNodeStore();
    await upsertExecutorNode({ nodeId, nodeKind: 'executor', status: 'online' });

    const seen: Array<{ command?: unknown; cwd?: unknown }> = [];
    const runtime = {
      'run-check': async (context: { input: { args?: Record<string, unknown> } }) => {
        seen.push({
          command: context.input.args?.command,
          cwd: context.input.args?.cwd,
        });
        return { status: 'succeeded' as const, output: { exitCode: 0, stdout: 'Linux' } };
      },
    };

    const record = await executeNodeCommand({
      nodeId,
      command: 'run-check',
      args: { command: 'uname -s', cwd: '/opt/los/los-workspace' },
    }, runtime as never);

    assert.equal(record.status, 'succeeded', `expected the runtime to run, got: ${record.error ?? ''}`);
    assert.deepEqual(seen, [{ command: 'uname -s', cwd: '/opt/los/los-workspace' }]);
    assert.equal((record.output as Record<string, unknown>).stdout, 'Linux');

    // 负向控制：没有 runtime 处理器时必须明确 denied（不得默默成功）
    const denied = await executeNodeCommand({
      nodeId,
      command: 'run-check',
      args: { command: 'uname -s' },
    }, {});
    assert.equal(denied.status, 'denied');
    assert.match(String(denied.error), /run-check requires an executor-side command runner/);
  } finally {
    // 必须清掉本用例造的那一行：`executor_nodes` 是**共享**的测试库表，
    // 残留行会以"最新的心跳"排到 `listExecutorNodes` 队首，进而改变别的用例里
    // `skipped[0]` 的内容（实测：一次 14:38 的残留让 `executor-client.test.ts`
    // 的 `skipped[0]` 从 `capability:sandbox_missing` 变成 `status:offline`）。
    await getDb().query('DELETE FROM executor_nodes WHERE node_id = $1', [nodeId]).catch(() => undefined);
    await getDb().query('DELETE FROM node_commands WHERE node_id = $1', [nodeId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
