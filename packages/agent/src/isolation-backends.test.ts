import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  ISOLATION_BACKENDS,
  declaredBackendIds,
  executeViaSandboxRun,
  parseSandboxRunReport,
  resolveAutoBackendId,
  resolveBackend,
} from './isolation-backends.js';

const execFileAsync = promisify(execFile);

/** 造一个只含 VCS 元目录的仓（不真的 init，探测只看目录 + 二进制）。 */
async function fakeRepo(kind: 'jj' | 'git' | 'none'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'los-probe-'));
  if (kind !== 'none') await mkdir(join(root, kind === 'jj' ? '.jj' : '.git'), { recursive: true });
  return root;
}

test('C2: declared backends are exactly the three contract ids', () => {
  assert.deepEqual(declaredBackendIds().sort(), ['docker', 'git-worktree', 'jj-workspace']);
  for (const id of declaredBackendIds()) assert.equal(ISOLATION_BACKENDS[id].id, id);
});

test('C2: jj-workspace probes a jj repo as available; non-jj fails with a reason', async () => {
  const jj = await fakeRepo('jj');
  const git = await fakeRepo('git');
  try {
    const ok = await ISOLATION_BACKENDS['jj-workspace'].probe({ repository: jj });
    assert.equal(ok.available, true);

    const bad = await ISOLATION_BACKENDS['jj-workspace'].probe({ repository: git });
    assert.equal(bad.available, false);
    // 契约纪律 3：不可用时**必须**给出原因，且原因要说清是什么问题
    assert.match((bad as { reason: string }).reason, /not a jj repository/);
  } finally {
    await rm(jj, { recursive: true, force: true });
    await rm(git, { recursive: true, force: true });
  }
});

test('C2: git-worktree probes a git repo as available; non-git fails with a reason', async () => {
  const git = await fakeRepo('git');
  try {
    const ok = await ISOLATION_BACKENDS['git-worktree'].probe({ repository: git });
    assert.equal(ok.available, true);
    const bad = await ISOLATION_BACKENDS['git-worktree'].probe({ repository: await fakeRepo('none') });
    assert.equal(bad.available, false);
    assert.match((bad as { reason: string }).reason, /not a git repository/);
  } finally {
    await rm(git, { recursive: true, force: true });
  }
});

test('C2: docker backend is delegated — it names sandbox-run in its unavailability reason', async () => {
  const git = await fakeRepo('git');
  try {
    const res = await ISOLATION_BACKENDS.docker.probe({ repository: git });
    // sandbox-run 是否在 PATH 上取决于本机；两种结果都必须**自证**
    if (res.available) {
      assert.equal(res.detail.delegatedTo, 'sandbox-run --backend docker');
    } else {
      assert.match(res.reason, /sandbox-run/, '不可用原因必须点名被委托的工具');
      assert.match(res.reason, /install|PATH/, '原因必须可操作（装它或设 PATH）');
    }
  } finally {
    await rm(git, { recursive: true, force: true });
  }
});

test('C2: docker without any VCS fails with a reason naming the missing checkout', async () => {
  const none = await fakeRepo('none');
  try {
    const res = await ISOLATION_BACKENDS.docker.probe({ repository: none });
    assert.equal(res.available, false);
    assert.match((res as { reason: string }).reason, /no git or jj repository/);
  } finally {
    await rm(none, { recursive: true, force: true });
  }
});

test('C2: auto resolves per VCS and REFUSES to guess on an unknown repo', async () => {
  const jj = await fakeRepo('jj');
  const git = await fakeRepo('git');
  const none = await fakeRepo('none');
  try {
    assert.equal(resolveAutoBackendId(jj), 'jj-workspace');
    assert.equal(resolveAutoBackendId(git), 'git-worktree');
    // 不猜：契约 backendSelection.autoResolution 明写 else ⇒ fail closed
    assert.equal(resolveAutoBackendId(none), null);

    const refused = await resolveBackend('auto', { repository: none });
    assert.ok('error' in refused);
    assert.match(refused.error, /refusing to guess/);
  } finally {
    for (const d of [jj, git, none]) await rm(d, { recursive: true, force: true });
  }
});

test('C2 NEGATIVE: an explicitly requested unavailable backend fails closed WITH A REASON (no silent fallback)', async () => {
  // 这是契约的核心纪律：显式指定 docker 但仓是 jj（且假定探不到 sandbox-run 时）
  // —— 无论探到与否，**都不得**悄悄改用 jj-workspace 而把 backend 字段写成谎话。
  const none = await fakeRepo('none');
  try {
    const res = await resolveBackend('docker', { repository: none });
    assert.ok('error' in res, '显式请求不可用的后端必须返回 error，不得回落到别的后端');
    assert.match(res.error, /isolation backend "docker" is unavailable/);
    assert.match(res.error, /no git or jj repository/);
  } finally {
    await rm(none, { recursive: true, force: true });
  }
});

test('C2 NEGATIVE: unknown backend id is rejected, never coerced', async () => {
  const git = await fakeRepo('git');
  try {
    const res = await resolveBackend('overlayfs' as never, { repository: git });
    assert.ok('error' in res);
    assert.match(res.error, /unknown isolation backend/);
    assert.match(res.error, /declared:/, '错误信息要列出已声明的 id，便于排障');
  } finally {
    await rm(git, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────
// C3：docker 后端委托 sandbox-run 的**执行**适配器
//
// 核心：适配器必须把**真实命令退出码**取出来交给上层，且**不自己造 verdict**。
// 实测到的坑（2026-10-08）：sandbox-run 的**进程退出码跨情形复用** ——
// 命令失败与"变更集为空被拒"**都是 1**。所以把进程码当命令码是错的。
// ─────────────────────────────────────────────────────────────

test('C3: parseSandboxRunReport reads the REAL exit code from verify.exitCode, not the process code', () => {
  // 真实样本（sandbox-run 0.1.3 实跑得到）
  const failed = JSON.stringify({
    runId: 'r1', verdict: 'fail', vcs: 'git',
    verify: { exitCode: 7, durationMs: 3 },
    sandbox: { backend: 'none', detail: null },
  });
  const p = parseSandboxRunReport(failed);
  assert.equal(p?.exitCode, 7, '必须取出真实命令码 7');
  assert.equal(p?.verdict, 'fail');

  // 空变更集被拒：进程码也是 1，但 verify.exitCode 为 null ⇒ **命令没跑**
  const rejected = JSON.stringify({
    runId: 'r2', verdict: 'rejected', vcs: 'git',
    verify: { exitCode: null, durationMs: 0 },
    sandbox: { backend: 'none', detail: 'no changes detected; nothing to verify' },
  });
  const r = parseSandboxRunReport(rejected);
  assert.equal(r?.exitCode, null, '"没跑"必须与"跑过且成功(0)"区分开');
  assert.equal(r?.verdict, 'rejected');
  assert.match(String(r?.detail), /no changes detected/);
});

test('C3 NEGATIVE: non-JSON stdout yields null report (never a fabricated code)', () => {
  assert.equal(parseSandboxRunReport('not json at all'), null);
  assert.equal(parseSandboxRunReport(''), null);
});

test('C3 NEGATIVE: a report without verify.exitCode is null, not 0', () => {
  const p = parseSandboxRunReport(JSON.stringify({ verdict: 'pass' }));
  assert.equal(p?.exitCode, null, '缺失的退出码绝不能默认成 0（那会把"未知"读成"成功"）');
});

test('C3: RawExecutionResult carries no verdict field (contract discipline 1)', async () => {
  const repo = await fakeRepo('git');
  try {
    const res = await executeViaSandboxRun({ repository: repo, command: 'true', timeoutMs: 30_000 });
    assert.equal('verdict' in res, false, '原始结果里不得有 verdict 字段');
    assert.equal('ok' in res, false);
    assert.ok('exitCode' in res && 'stdout' in res && 'stderr' in res && 'durationMs' in res);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('C3: missing sandbox-run is reported as an environment fault (exitCode null), not a command failure', async () => {
  // 用一个只含空目录的 PATH 让 which() 找不到 sandbox-run
  const empty = await mkdtemp(join(tmpdir(), 'los-nopath-'));
  const repo = await fakeRepo('git');
  const saved = process.env.PATH;
  process.env.PATH = empty;
  try {
    const res = await executeViaSandboxRun({ repository: repo, command: 'true', timeoutMs: 10_000 });
    assert.equal(res.exitCode, null, '环境故障不得伪装成命令失败');
    assert.match(res.stderr, /sandbox-run not found/);
    assert.equal(res.observed?.spawnError, 'sandbox-run-missing');
  } finally {
    process.env.PATH = saved;
    await rm(empty, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});
