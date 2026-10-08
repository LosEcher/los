import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { getDb } from '@los/infra/db';
import { ConfigSchema, getConfig as loadConfigSync, setConfig } from '@los/infra/config';
import { createAgentTask, ensureAgentTaskGraphStore, listAgentTasksForGraph } from './agent-task-graph.js';
import { ensureArtifactStore, readArtifactContent } from './artifacts.js';
import {
  backupManagedWorkspace,
  createManagedWorkspace,
  ensureManagedWorkspaceStore,
  loadManagedWorkspaceDetail,
  releaseManagedWorkspace,
  workspaceRootForTask,
} from './managed-workspaces.js';

const execFileAsync = promisify(execFile);

test('managed jj workspace assigns a task, backs up its diff, and releases with durable evidence', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const graphId = `workspace-graph-${suffix}`;
  const taskId = `workspace-task-${suffix}`;
  const workspaceId = `workspace-${suffix}`;
  const root = await mkdtemp(join(tmpdir(), 'los-managed-workspace-'));
  const sourceRoot = join(root, 'source');
  const artifactRoot = join(root, 'artifacts');
  await execFileAsync('jj', ['git', 'init', sourceRoot]);

  await ensureAgentTaskGraphStore();
  await ensureArtifactStore();
  await ensureManagedWorkspaceStore();
  await createAgentTask({
    id: taskId,
    graphId,
    role: 'executor',
    title: 'Edit isolated file',
    metadata: { editableSurfaces: ['src/isolation.ts'] },
  });

  let createdRoot: string | undefined;
  try {
    const created = await createManagedWorkspace({
      workspaceId,
      graphId,
      taskId,
      projectId: 'test-project',
      sourceRoot,
      createdBy: 'test-operator',
    });
    createdRoot = created.workspaceRoot;
    assert.equal(created.status, 'active');
    assert.equal((await stat(created.workspaceRoot)).isDirectory(), true);
    const [assigned] = await listAgentTasksForGraph(graphId);
    assert.equal(assigned?.metadata.managedWorkspaceId, workspaceId);
    assert.equal(workspaceRootForTask(assigned!, sourceRoot), created.workspaceRoot);

    await writeFile(join(created.workspaceRoot, 'isolated.txt'), 'workspace change\n', 'utf8');
    const backedUp = await backupManagedWorkspace(workspaceId, 'test-operator', {
      artifactStorageRoot: artifactRoot,
      nodeId: 'test-node',
    });
    assert.equal(backedUp.status, 'backup_ready');
    assert.ok(backedUp.backupArtifactId);
    const backup = await readArtifactContent(backedUp.backupArtifactId!);
    assert.match(backup?.content.toString('utf8') ?? '', /isolated\.txt/);

    const released = await releaseManagedWorkspace(workspaceId, 'test-operator', {
      artifactStorageRoot: artifactRoot,
      nodeId: 'test-node',
    });
    assert.equal(released.status, 'released');
    await assert.rejects(stat(released.workspaceRoot));
    const [cleared] = await listAgentTasksForGraph(graphId);
    assert.equal(cleared?.metadata.managedWorkspaceId, undefined);
    assert.equal(workspaceRootForTask(cleared!, sourceRoot), sourceRoot);

    const detail = await loadManagedWorkspaceDetail(workspaceId);
    assert.deepEqual(detail?.events.map(event => event.eventType), [
      'workspace.create_requested',
      'workspace.active',
      'workspace.backup_created',
      'workspace.backup_created',
      'workspace.released',
    ]);
    const releaseArtifact = await readArtifactContent(released.backupArtifactId!);
    assert.equal(await readFile(releaseArtifact!.record.storagePath, 'utf8'), releaseArtifact!.content.toString('utf8'));
  } finally {
    await getDb().query('DELETE FROM managed_workspace_events WHERE workspace_id = $1', [workspaceId]).catch(() => undefined);
    await getDb().query('DELETE FROM managed_workspaces WHERE workspace_id = $1', [workspaceId]).catch(() => undefined);
    await getDb().query('DELETE FROM agent_tasks WHERE graph_id = $1', [graphId]).catch(() => undefined);
    if (createdRoot) {
      await execFileAsync('jj', ['-R', sourceRoot, 'workspace', 'forget', `los-${workspaceId}`]).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────
// C1（ADR 0047 §5.1）：`vcs_kind` → `backend`
//
// 背景：`vcs_kind: 'jj'` 把"哪个 VCS"与"怎么隔离"混为一谈。C1 把它改为可扩展的
// backend id，内建 jj 后端名为 `jj-workspace`。这些断言固定住迁移后的行为，
// 尤其是**负向控制**：CHECK 约束必须真的挡住非法 backend，否则"枚举"只是文档。
// ─────────────────────────────────────────────────────────────
test('C1: managed workspace records the isolation backend (default jj-workspace)', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const graphId = `backend-graph-${suffix}`;
  const taskId = `backend-task-${suffix}`;
  const workspaceId = `backend-ws-${suffix}`;
  const root = await mkdtemp(join(tmpdir(), 'los-backend-'));
  const sourceRoot = join(root, 'source');
  await execFileAsync('jj', ['git', 'init', sourceRoot]);

  await ensureAgentTaskGraphStore();
  await ensureManagedWorkspaceStore();
  await createAgentTask({
    id: taskId, graphId, role: 'executor', title: 'backend field',
    metadata: { editableSurfaces: ['src/x.ts'] },
  });

  try {
    const ws = await createManagedWorkspace({
      workspaceId, graphId, taskId, projectId: 'los', sourceRoot, createdBy: 'test',
    });
    assert.equal(ws.backend, 'jj-workspace', '缺省 backend 必须是内建 jj 后端的新名字');
    // 旧字段名不得复现
    assert.equal((ws as unknown as Record<string, unknown>).vcsKind, undefined);

    // 从 DB 重新读出来也要是新的列
    const rows = await getDb().query<{ backend: string }>(
      'SELECT backend FROM managed_workspaces WHERE workspace_id = $1', [workspaceId]);
    assert.equal(rows.rows[0]?.backend, 'jj-workspace');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('C1 NEGATIVE: an undeclared backend id is rejected by the CHECK constraint', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const workspaceId = `backend-bad-${suffix}`;
  await ensureManagedWorkspaceStore();
  // 绕过 TS 类型直接写库：约束必须在**数据库层**挡住，而不只是类型层。
  // （类型只在编译期生效；这一条是运行时防线。）
  await assert.rejects(
    () => getDb().query(
      `INSERT INTO managed_workspaces (
         workspace_id, graph_id, task_id, project_id, source_root, workspace_root,
         workspace_name, backend, base_revision, status, created_by, metadata_json
       ) VALUES ($1,'g','t','los','/s','/w','n',$2,'rev','creating','test','{}'::jsonb)`,
      [workspaceId, 'not-a-declared-backend'],
    ),
    /managed_workspaces_backend_chk|violates check constraint/i,
    '非法 backend 必须被 CHECK 拒绝，否则枚举形同虚设',
  );
});

// ─────────────────────────────────────────────────────────────
// C4：`isolation.backend` 配置面接线（ADR 0047 §5.1）
//
// 契约要点：显式指定而不可用 ⇒ **fail closed 带原因**；**静默回落到另一个后端
// 是契约违规**（会让账本里的 backend 字段变成谎话）。且解析/探测必须在**任何
// 副作用之前** —— 否则账本里会留下一条从未真实存在的记录。
// ─────────────────────────────────────────────────────────────
test('C4 NEGATIVE: an explicit unavailable backend refuses BEFORE writing any ledger row', async () => {
  const previous = loadConfigSync();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const workspaceId = `c4-refuse-${suffix}`;
  const root = await mkdtemp(join(tmpdir(), 'los-c4-'));
  // 既非 jj 也非 git 的目录 ⇒ auto 无法解析；显式指定 docker 也必然不可用
  const sourceRoot = join(root, 'plain');
  await mkdir(sourceRoot, { recursive: true });
  await ensureManagedWorkspaceStore();
  try {
    setConfig(ConfigSchema.parse({ ...previous, isolation: { backend: 'docker' } }));
    await assert.rejects(
      () => createManagedWorkspace({
        workspaceId, graphId: `g-${suffix}`, taskId: `t-${suffix}`,
        projectId: 'los', sourceRoot, createdBy: 'test',
      }),
      /isolation backend "docker" is unavailable/,
      '显式请求不可用的后端必须 fail-closed 并带 probe 原因',
    );
    // **核心**：拒绝必须"干净" —— 账本里不得留下任何痕迹
    const rows = await getDb().query(
      'SELECT workspace_id FROM managed_workspaces WHERE workspace_id = $1', [workspaceId]);
    assert.equal(rows.rows.length, 0, 'fail-closed 时不得写入 managed_workspaces 行');
  } finally {
    setConfig(previous);
    await rm(root, { recursive: true, force: true });
  }
});

test('C4 NEGATIVE: auto on a non-VCS directory refuses to guess', async () => {
  const previous = loadConfigSync();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const root = await mkdtemp(join(tmpdir(), 'los-c4-auto-'));
  const sourceRoot = join(root, 'plain');
  await mkdir(sourceRoot, { recursive: true });
  try {
    setConfig(ConfigSchema.parse({ ...previous, isolation: { backend: 'auto' } }));
    await assert.rejects(
      () => createManagedWorkspace({
        workspaceId: `c4-auto-${suffix}`, graphId: `g-${suffix}`, taskId: `t-${suffix}`,
        projectId: 'los', sourceRoot, createdBy: 'test',
      }),
      /refusing to guess/,
      'auto 在既非 jj 也非 git 的仓上必须拒绝，而不是猜一个后端',
    );
  } finally {
    setConfig(previous);
    await rm(root, { recursive: true, force: true });
  }
});

test('C4: a resolved but not-yet-wired backend says so instead of silently using jj', async () => {
  const previous = loadConfigSync();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const root = await mkdtemp(join(tmpdir(), 'los-c4-git-'));
  const sourceRoot = join(root, 'gitrepo');
  await execFileAsync('git', ['init', '-q', sourceRoot]);
  try {
    setConfig(ConfigSchema.parse({ ...previous, isolation: { backend: 'git-worktree' } }));
    await assert.rejects(
      () => createManagedWorkspace({
        workspaceId: `c4-git-${suffix}`, graphId: `g-${suffix}`, taskId: `t-${suffix}`,
        projectId: 'los', sourceRoot, createdBy: 'test',
      }),
      /create path is not wired yet/,
      'C2 只实现了 probe；create 未接线时必须**明说**，不得悄悄按 jj 建出来再记账成别的 backend',
    );
  } finally {
    setConfig(previous);
    await rm(root, { recursive: true, force: true });
  }
});
