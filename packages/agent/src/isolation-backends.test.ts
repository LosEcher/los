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
