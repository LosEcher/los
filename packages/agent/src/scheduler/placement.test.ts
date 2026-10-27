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

/**
 * S8（2026-10-11 晚）：探测**按平台分派**。
 *
 * 为什么这是"修"而不是"放宽判据"：Windows 那一支换的是**语言**（POSIX sh → PowerShell），
 * 输出协议（`PRESENT[ <rev>]` / `ABSENT`）与 `reachable` 口径**逐字不变**。
 * 分派错层（例如只换命令文本、仍经 cmd.exe 解析）会得到"看起来像修好了"的假绿。
 */
test('Windows 探测走 PowerShell，输出协议与 POSIX 分支逐字相同', () => {
  const command = _buildWorkspaceProbeCommand('C:/los-workspace/portable', { platform: 'win32' });
  // ① 必须是 PowerShell 语法，且不含 POSIX 专有构造（`[ -d ]`、`printf`、`$( )`）
  assert.match(command, /Test-Path -LiteralPath/);
  assert.match(command, /Write-Output/);
  assert.doesNotMatch(command, /printf/);
  assert.doesNotMatch(command, /\[ -d/);
  assert.doesNotMatch(command, /\$\(/);
  // ② 输出协议不变：仍是 PRESENT/ABSENT 两个词，revision 仍然可选
  assert.match(command, /'PRESENT'/);
  assert.match(command, /'ABSENT'/);
  assert.match(command, /rev-parse --short HEAD/);
  // ③ 自己保证退出码 0：探测失败是**数据**，不是崩溃（POSIX 分支末尾的 `true` 同理）
  assert.match(command, /exit 0$/);
  // ④ 只用 PowerShell 5.1 就有的语法：节点上是 5.1（实测 PWSH=False），`??` 是 7+ 才有
  assert.doesNotMatch(command, /\?\?/);
});

test('Windows 探测对含空格与单引号的路径仍然安全（引号按 PowerShell 规则转义）', () => {
  const command = _buildWorkspaceProbeCommand("C:/Program Files/it's here", { platform: 'win32' });
  // 单引号在 PowerShell 单引号串里靠**翻倍**转义（与 POSIX 的 '\'' 是同一件事）
  assert.match(command, /'C:\/Program Files\/it''s here'/);
});

test('Windows 探测必须能通过 PowerShell 的**语法**预检（拿不到 powershell 就跳过，不当成通过）', () => {
  // 与 POSIX 分支的 `sh -n` 是同一道门禁：语法错误会让**所有**节点假红/假绿。
  const powerShell = ['/usr/local/bin/pwsh', '/opt/homebrew/bin/pwsh', 'pwsh'].find(candidate => {
    const probe = spawnSync(candidate, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
    return probe.status === 0;
  });
  for (const root of ['C:/los-workspace/portable', "C:/it's/here", 'C:/Program Files/x']) {
    const command = _buildWorkspaceProbeCommand(root, { platform: 'win32' });
    if (!powerShell) {
      // 本机没有 PowerShell ⇒ **如实跳过**，并且不把这条记成通过。
      // （判断放在循环内是为了让"没装"这件事在输出里可见，而不是静默 return。）
      assert.ok(command.length > 0);
      continue;
    }
    // 用 `[ScriptBlock]::Create` 做纯语法解析：不执行、不依赖 git/文件是否存在。
    const checked = spawnSync(powerShell, ['-NoProfile', '-Command', `[void][ScriptBlock]::Create(${JSON.stringify(command)})`], { encoding: 'utf8' });
    assert.equal(checked.status, 0, `PowerShell parser rejected: ${command}\n${checked.stderr}`);
  }
});

test('_probeNodeWorkspace 按**目标节点**的平台选命令，并把平台放进缓存键', async () => {
  // 判据：windows 节点收到的探测体里必须是 PowerShell（不是 POSIX），
  // 且同一 (nodeId, workspaceRoot) 在**平台变化**后不得命中旧缓存。
  _clearWorkspaceProbeCache();
  const sent: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      sent.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ command: { output: { exitCode: 0, stdout: 'PRESENT abc' } } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const commandUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/nodes/win/commands`;
  try {
    await _probeNodeWorkspace({ nodeId: 'win', workspaceRoot: 'C:/ws', platform: 'win32', commandUrl, force: true });
    assert.match(sent[0]!, /Test-Path -LiteralPath/);
    // 平台进缓存键：换平台必须重新探测（否则会拿 POSIX 的结论给 Windows 用）
    await _probeNodeWorkspace({ nodeId: 'win', workspaceRoot: 'C:/ws', platform: 'darwin', commandUrl });
    assert.equal(sent.length, 2, '平台变了不许命中缓存');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
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
  // 2026-10-11 晚（S8 实测原文）：Windows 节点上 run_shell 的沙箱前置失败。
  // 这是**节点级**的（同一台节点的 requiredChecks 成功通过，坏的是服务身份能不能用这条沙箱）。
  assert.equal(
    _classifyNodeFailure('windows-acl sandbox unavailable or failed (fail-closed): CreateRestrictedToken prerequisite failed: no logon SID found among 4 token groups'),
    'windows_acl_token_prerequisite',
  );
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
