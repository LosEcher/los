import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawnSync } from 'node:child_process';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import type { ExecutorNodeRecord } from '../executor-nodes.js';
import {
  _buildWorkspaceProbeCommand,
  _classifyNodeFailure,
  _clearWorkspaceProbeCache,
  _normalizePlacementPolicy,
  _normalizeWorkspacePolicy,
  _probeNodeWorkspace,
  choosePlacement,
} from './placement.js';

/**
 * placement 的单测：**不碰真机**。
 *
 * 探测通道是 HTTP（`/v1/nodes/:id/commands`），所以这里起一个本地假节点，
 * 让"节点报什么"由测试决定——这比 mock 掉 `createNodeCheckRunner` 强：
 * 它连带验证了请求形状（`command: 'run-check'` + `args.command`）与响应解析。
 */

function node(nodeId: string, overrides: Partial<ExecutorNodeRecord> = {}): ExecutorNodeRecord {
  return {
    nodeId,
    nodeKind: 'executor',
    status: 'online',
    version: '0.1.0+test',
    connectModes: ['agent_http'],
    connectConfig: { agent_http: { baseUrl: `http://127.0.0.1:1/${nodeId}`, commandUrl: `http://127.0.0.1:1/${nodeId}` } },
    capacity: { memoryTotalMb: 8192, memoryAvailableMb: 4096 },
    capabilities: { run_agent: true },
    verified: { agent_http: { ok: true } },
    queueDepth: 0,
    activeTaskCount: 0,
    meshLinks: [],
    lastHeartbeatAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    execution: { candidate: true, mode: 'agent_http', blockers: [], warnings: [] },
    ...overrides,
  };
}

/** 假节点：按 nodeId 决定 stdout/退出码，并统计请求次数（缓存测试要用）。 */
async function withFakeNodes(
  behaviour: Record<string, { stdout?: string; exitCode?: number; status?: number; bodies?: string[] }>,
  run: (input: { port: number; hits: () => number }) => Promise<void>,
): Promise<void> {
  let hits = 0;
  const server: Server = createServer((req, res) => {
    hits += 1;
    const nodeId = decodeURIComponent((req.url ?? '').split('/')[3] ?? '');
    const rule = behaviour[nodeId] ?? { stdout: '', status: 200 };
    rule.bodies?.push('hit');
    if (rule.status && rule.status !== 200) {
      res.writeHead(rule.status, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      command: {
        command: 'run-check',
        output: { exitCode: rule.exitCode ?? 0, stdout: rule.stdout ?? '', stderr: '' },
      },
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run({ port, hits: () => hits });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('_buildWorkspaceProbeCommand quotes the path and answers PRESENT/ABSENT in one round trip', () => {
  const command = _buildWorkspaceProbeCommand("/tmp/it's here");
  assert.match(command, /d='\/tmp\/it'\\''s here'/);
  // 一条命令同时回答存在性与 revision —— 两次往返等于两倍瞬时失败面。
  assert.match(command, /printf PRESENT/);
  assert.match(command, /rev-parse --short HEAD/);
  assert.match(command, /printf ABSENT/);
});

test('_buildWorkspaceProbeCommand 产出的命令必须是**语法合法**的 sh（本模块上线首日就栽在这）', () => {
  // 实测事故：漏一个 `;` ⇒ 所有节点都返回 `Syntax error: "then" unexpected`，
  // 而当时的 reachable 只看"有没有退出码" ⇒ 每个节点都被判成"已核实"。
  // 用 `sh -n` 做语法校验是能机械抓住这一类错误的**唯一**低成本办法。
  for (const root of ['/tmp', "/tmp/it's here", '/opt/los/los-workspace', '']) {
    const command = _buildWorkspaceProbeCommand(root);
    const result = spawnSync('/bin/sh', ['-n', '-c', command], { encoding: 'utf8' });
    assert.equal(result.status, 0, `sh -n rejected: ${command}\n${result.stderr}`);
  }
});

test('_buildWorkspaceProbeCommand 的探测**真在本地跑得通**（有/无工作区两种答案）', () => {
  // 不只是语法：真的执行一次。这条会在 macOS/Linux 上用"节点上没有 bwrap"的回退分支，
  // 因此是探针里"沙箱不可用也要能回答工作区问题"这一支的机械守护。
  const existing = spawnSync('/bin/sh', ['-c', _buildWorkspaceProbeCommand('/tmp')], { encoding: 'utf8' });
  assert.equal(existing.status, 0);
  assert.match(existing.stdout.trim(), /^PRESENT/);

  const missing = spawnSync('/bin/sh', ['-c', _buildWorkspaceProbeCommand('/definitely/not/here-xyz')], { encoding: 'utf8' });
  assert.equal(missing.status, 0);
  assert.equal(missing.stdout.trim(), 'ABSENT');
});

test('声明有沙箱但沙箱跑不动 ⇒ SANDBOX_FAILED（vultr 那一类的机械复现）', () => {
  // 实测事故（2026-10-11，vultr）：`capabilities.sandbox = linux-bwrap`，二进制在，
  // 但以服务用户身份跑会 `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`，
  // 于是 agent 的 run_shell 全失败、任务跑到一半才炸。
  // 用假 bwrap（退出码 5 + 一条 stderr）复现该形态：探测必须给出可识别的失败，
  // 而不是冒充 PRESENT/ABSENT。
  const fake = join(tmpdir(), `fake-bwrap-${process.pid}-${Date.now()}.sh`);
  writeFileSync(fake, '#!/bin/sh\necho "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted" >&2\nexit 5\n');
  chmodSync(fake, 0o755);
  try {
    const command = _buildWorkspaceProbeCommand('/tmp', { bwrapPath: fake });
    const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
    assert.equal(result.status, 0, '包装层自己必须成功退出（失败是**数据**，不是崩溃）');
    assert.match(result.stdout, /^SANDBOX_FAILED rc=5/);
    assert.match(result.stdout, /Failed RTM_NEWADDR/);
  } finally {
    rmSync(fake, { force: true });
  }
});

test('normalize*Policy defaults to the code default when nothing is configured', () => {
  // 显式值优先；非法值不得静默当成另一个合法值（退化成默认）。
  assert.equal(_normalizePlacementPolicy('health'), 'health');
  assert.equal(_normalizePlacementPolicy('verified-rotate'), 'verified-rotate');
  assert.equal(_normalizeWorkspacePolicy('portable'), 'portable');
  assert.equal(_normalizeWorkspacePolicy('verify'), 'verify');
  assert.equal(_normalizeWorkspacePolicy('nonsense'), 'verify');
});

test('_probeNodeWorkspace reports reachability, presence and revision', async () => {
  await withFakeNodes({ a: { stdout: 'PRESENT abc1234' }, b: { stdout: 'ABSENT' } }, async ({ port }) => {
    const present = await _probeNodeWorkspace({ nodeId: 'a', workspaceRoot: '/ws', commandUrl: `http://127.0.0.1:${port}/v1/nodes/a/commands`, force: true });
    assert.equal(present.reachable, true);
    assert.equal(present.present, true);
    assert.equal(present.revision, 'abc1234');

    const absent = await _probeNodeWorkspace({ nodeId: 'b', workspaceRoot: '/ws', commandUrl: `http://127.0.0.1:${port}/v1/nodes/b/commands`, force: true });
    assert.equal(absent.present, false);
    assert.equal(absent.revision, undefined);
  });
});

test('probe failure is a first-class outcome, not an exception', async () => {
  _clearWorkspaceProbeCache();
  const outcome = await _probeNodeWorkspace({
    nodeId: 'nowhere',
    workspaceRoot: '/ws',
    commandUrl: 'http://127.0.0.1:9/v1/nodes/nowhere/commands',
    timeoutMs: 1_000,
    force: true,
  });
  assert.equal(outcome.reachable, false);
  assert.equal(outcome.present, false);
  assert.ok(outcome.error);
});

test('reachable 要求"退出码 0 **且**输出可解析"，不是"有退出码"', async () => {
  _clearWorkspaceProbeCache();
  await withFakeNodes(
    {
      syntaxerror: { stdout: 'Syntax error: "then" unexpected', exitCode: 2 },
      mojibake: { stdout: 'ϵͳ�Ҳ���ָ����·����', exitCode: 0 }, // Windows 节点实测返回
      ok: { stdout: 'ABSENT', exitCode: 0 },
    },
    async ({ port }) => {
      const url = (id: string) => `http://127.0.0.1:${port}/v1/nodes/${id}/commands`;
      const bad = await _probeNodeWorkspace({ nodeId: 'syntaxerror', workspaceRoot: '/ws', commandUrl: url('syntaxerror'), force: true });
      assert.equal(bad.reachable, false, '命令没跑通不算可达');
      assert.match(String(bad.error), /did not answer|Syntax error/);

      const win = await _probeNodeWorkspace({ nodeId: 'mojibake', workspaceRoot: '/ws', commandUrl: url('mojibake'), force: true });
      assert.equal(win.reachable, false, '输出不可解析不算可达（否则 Windows 节点会混进 portable 轮转）');

      const good = await _probeNodeWorkspace({ nodeId: 'ok', workspaceRoot: '/ws', commandUrl: url('ok'), force: true });
      assert.equal(good.reachable, true);
      assert.equal(good.present, false);
    },
  );
});

test('probe results are cached (and negative results are cached separately)', async () => {
  _clearWorkspaceProbeCache();
  await withFakeNodes({ a: { stdout: 'PRESENT abc1234' } }, async ({ port, hits }) => {
    const url = `http://127.0.0.1:${port}/v1/nodes/a/commands`;
    await _probeNodeWorkspace({ nodeId: 'a', workspaceRoot: '/ws', commandUrl: url });
    assert.equal(hits(), 1);
    const second = await _probeNodeWorkspace({ nodeId: 'a', workspaceRoot: '/ws', commandUrl: url });
    assert.equal(hits(), 1, 'TTL 内不允许再打节点');
    assert.equal(second.cached, true);
    await _probeNodeWorkspace({ nodeId: 'a', workspaceRoot: '/ws', commandUrl: url, force: true });
    assert.equal(hits(), 2, 'force 必须绕过缓存（自检要拿"此刻"的真值）');
  });
});

test('_classifyNodeFailure 只认节点级失败，不认任务级失败', () => {
  // 实测原文（vultr-executor 2026-10-11）：节点上没有 provider 凭据，心跳与命令通道却都正常。
  assert.equal(
    _classifyNodeFailure("Provider 'deepseek' not configured. Set DEEPSEEK_API_KEY or add to ~/.los/accounts/"),
    'provider_not_configured',
  );
  assert.equal(_classifyNodeFailure('fetch failed'), 'transport');
  assert.equal(_classifyNodeFailure('unauthorized'), 'auth');
  assert.equal(_classifyNodeFailure('executor_draining'), 'draining');
  // 任务级失败**不得**让节点被降权：模型答得不对、验证没过都是任务的问题。
  assert.equal(_classifyNodeFailure('verification failed: unchecked requirement'), undefined);
  assert.equal(_classifyNodeFailure('the model replied with the wrong sentence'), undefined);
  assert.equal(_classifyNodeFailure(null), undefined);
});

test('choosePlacement: 没声明工作区时走既有健康序，且不打节点', async () => {
  _clearWorkspaceProbeCache();
  const ordered = [node('head'), node('second')];
  const choice = await choosePlacement({ ordered, workspacePolicy: 'verify', placementPolicy: 'verified-rotate' });
  assert.equal(choice?.node.nodeId, 'head');
  assert.equal(choice?.evidence.basis, 'no_workspace_declared');
  // capacity 快照是这个模块存在的理由之一（§4.2 事后复核）。
  assert.equal((choice?.evidence.capacity as Record<string, { memoryAvailableMb: number }>).head!.memoryAvailableMb, 4096);
});

test("choosePlacement: policy='health' 保持旧行为，只补证据", async () => {
  const ordered = [node('mbp'), node('node34')];
  const choice = await choosePlacement({
    ordered,
    workspaceRoot: '/ws',
    placementPolicy: 'health',
  });
  assert.equal(choice?.node.nodeId, 'mbp');
  assert.equal(choice?.evidence.basis, 'health_order');
  assert.deepEqual(choice?.evidence.eligibleRanked, ['mbp', 'node34']);
});

test("choosePlacement: verify 策略只接受'工作区确实在节点上'的候选", async () => {
  _clearWorkspaceProbeCache();
  await withFakeNodes({ only: { stdout: 'PRESENT deadbee' }, other: { stdout: 'ABSENT' } }, async ({ port }) => {
    const url = (id: string) => `http://127.0.0.1:${port}/v1/nodes/${id}/commands`;
    // 既有健康序把 other 排在前面，但它上面**没有**这个工作区。
    const ordered = [
      node('other', { connectConfig: { agent_http: { commandUrl: url('other') } } }),
      node('only', { connectConfig: { agent_http: { commandUrl: url('only') } } }),
    ];
    const choice = await choosePlacement({
      ordered,
      workspaceRoot: '/ws',
      workspacePolicy: 'verify',
      placementPolicy: 'verified-rotate',
    });
    assert.equal(choice?.node.nodeId, 'only');
    assert.equal(choice?.evidence.basis, 'single_verified');
    assert.deepEqual(choice?.evidence.verifiedNodeIds, ['only']);
  });
});

test("choosePlacement: portable 只要求节点可达（工作区不必存在）", async () => {
  _clearWorkspaceProbeCache();
  await withFakeNodes({ a: { stdout: 'ABSENT' }, b: { stdout: 'ABSENT' } }, async ({ port }) => {
    const url = (id: string) => `http://127.0.0.1:${port}/v1/nodes/${id}/commands`;
    const ordered = [
      node('a', { connectConfig: { agent_http: { commandUrl: url('a') } } }),
      node('b', { connectConfig: { agent_http: { commandUrl: url('b') } } }),
    ];
    const choice = await choosePlacement({
      ordered,
      workspaceRoot: '/ws',
      workspacePolicy: 'portable',
      placementPolicy: 'verified-rotate',
    });
    assert.deepEqual(choice?.evidence.verifiedNodeIds, ['a', 'b']);
    assert.equal(choice?.evidence.basis, 'verified_rotation');
  });
});

test('choosePlacement: 全都核实不过 ⇒ 回退既有健康序，并如实标记 basis', async () => {
  _clearWorkspaceProbeCache();
  await withFakeNodes({ a: { stdout: 'ABSENT' }, b: { stdout: 'ABSENT' } }, async ({ port }) => {
    const url = (id: string) => `http://127.0.0.1:${port}/v1/nodes/${id}/commands`;
    const choice = await choosePlacement({
      ordered: [
        node('a', { connectConfig: { agent_http: { commandUrl: url('a') } } }),
        node('b', { connectConfig: { agent_http: { commandUrl: url('b') } } }),
      ],
      workspaceRoot: '/ws',
      workspacePolicy: 'verify',
      placementPolicy: 'verified-rotate',
    });
    assert.equal(choice?.node.nodeId, 'a');
    assert.equal(choice?.evidence.basis, 'probe_fallback_health');
    assert.deepEqual(choice?.evidence.verifiedNodeIds, []);
  });
});

test('choosePlacement: 探测只在健康序前 N 个候选上做（派发路径上的封顶）', async () => {
  _clearWorkspaceProbeCache();
  await withFakeNodes({ a: { stdout: 'PRESENT x' }, b: { stdout: 'PRESENT y' }, c: { stdout: 'PRESENT z' } }, async ({ port }) => {
    const url = (id: string) => `http://127.0.0.1:${port}/v1/nodes/${id}/commands`;
    const ordered = ['a', 'b', 'c'].map(id => node(id, { connectConfig: { agent_http: { commandUrl: url(id) } } }));
    const choice = await choosePlacement({
      ordered,
      workspaceRoot: '/ws',
      workspacePolicy: 'verify',
      placementPolicy: 'verified-rotate',
      maxProbes: 2,
    });
    assert.deepEqual(choice?.evidence.verifiedNodeIds, ['a', 'b']);
    assert.equal((choice?.evidence.probes as unknown[]).length, 2);
  });
});
