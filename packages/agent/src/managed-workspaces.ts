import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { getConfig } from '@los/infra/config';
import { promisify } from 'node:util';
import { putArtifact } from './artifacts.js';
import { ISOLATION_BACKENDS, resolveBackend } from './isolation-backends.js';
import { runRaw } from './isolation/types.js';
import {
  appendManagedWorkspaceEvent,
  assignManagedWorkspaceToTask,
  clearManagedWorkspaceFromTask,
  insertManagedWorkspace,
  loadManagedWorkspace,
  updateManagedWorkspace,
} from './managed-workspace-store.js';
import type {
  CreateManagedWorkspaceInput,
  ManagedWorkspaceRecord,
  ManagedWorkspaceRuntimeOptions,
} from './managed-workspace-types.js';

export {
  ensureManagedWorkspaceStore,
  listManagedWorkspaces,
  loadManagedWorkspace,
  loadManagedWorkspaceDetail,
} from './managed-workspace-store.js';
export type {
  CreateManagedWorkspaceInput,
  ListManagedWorkspacesOptions,
  ManagedWorkspaceDetail,
  ManagedWorkspaceEvent,
  ManagedWorkspaceRecord,
  ManagedWorkspaceRuntimeOptions,
  ManagedWorkspaceStatus,
} from './managed-workspace-types.js';

const execFileAsync = promisify(execFile);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_OUTPUT = 4 * 1024 * 1024;

export async function createManagedWorkspace(input: CreateManagedWorkspaceInput): Promise<ManagedWorkspaceRecord> {
  for (const [name, value] of Object.entries({
    workspaceId: input.workspaceId,
    graphId: input.graphId,
    taskId: input.taskId,
    projectId: input.projectId,
  })) requireSafeId(value, name);
  const sourceRoot = await realpath(resolve(input.sourceRoot));
  if (!(await stat(sourceRoot)).isDirectory()) throw new Error('sourceRoot must be a directory');

  // ── C4：解析并探测隔离后端（ADR 0047 §5.1 / contracts/isolation-backend.yaml）
  //
  // **必须在任何副作用之前**：探测失败要"干净地拒绝"，而不是先写一行
  // status='creating' 再把它标成 failed —— 那会在账本里留下一条从未真实存在的记录。
  //
  // 语义（契约）：显式指定而不可用 ⇒ fail closed **带 probe 原因**；
  // **静默回落到另一个后端是契约违规**（会让账本记录的 backend 变成谎话）。
  const requested = input.backend ?? getConfig().isolation.backend;
  const resolved = await resolveBackend(requested, { repository: sourceRoot });
  if ('error' in resolved) throw new Error(resolved.error);
  const backendId = resolved.backend.id;
  const backend = resolved.backend;
  // 基础修订仍从 VCS 读取。**只有 jj 后端需要先确认根**；git 后端由它自己的
  // create 处理（`git worktree add` 会在非仓时失败并给出原始 stderr）。
  let baseRevision: string;
  if (backendId === 'jj-workspace') {
    await runJj(sourceRoot, ['root']);
    baseRevision = (await runJj(sourceRoot, ['log', '-r', '@-', '--no-graph', '-T', 'commit_id.short(12)'])).trim();
  } else if (backendId === 'git-worktree') {
    const rev = await runRaw('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, timeoutMs: 30_000 });
    if (rev.exitCode !== 0) throw new Error(`git rev-parse HEAD failed: ${rev.stderr.trim() || rev.stdout.trim()}`);
    baseRevision = rev.stdout.trim().slice(0, 12);
  } else {
    // 委托面（docker）：隔离资源由第三方在 execute 时建立，基础修订交给它自己解析。
    baseRevision = 'delegated';
  }

  const managedRoot = managedRootForSource(sourceRoot, input.projectId);
  const workspaceRoot = resolve(managedRoot, input.workspaceId);
  assertManagedPath(workspaceRoot, managedRoot);
  const workspaceName = `los-${input.workspaceId}`;
  const existing = await loadManagedWorkspace(input.workspaceId);
  if (existing) return existing;

  const record = await insertManagedWorkspace({
    workspaceId: input.workspaceId,
    graphId: input.graphId,
    taskId: input.taskId,
    projectId: input.projectId,
    sourceRoot,
    workspaceRoot,
    workspaceName,
    backend: backendId,
    baseRevision,
    status: 'creating',
    createdBy: input.createdBy,
    metadata: input.metadata ?? {},
  });
  await appendManagedWorkspaceEvent({
    workspaceId: record.workspaceId,
    eventType: 'workspace.create_requested',
    actor: input.createdBy,
    payload: { graphId: record.graphId, taskId: record.taskId, baseRevision },
  });

  try {
    await mkdir(managedRoot, { recursive: true });
    // 委派给解析出的后端（契约：los 拥有身份与生命周期，机制由后端提供）
    await backend.create({
      repository: sourceRoot,
      path: workspaceRoot,
      name: workspaceName,
      baseRevision,
      label: `los managed workspace for ${input.graphId}/${input.taskId}`,
    });
    const active = await updateManagedWorkspace(record.workspaceId, { status: 'active' });
    await assignManagedWorkspaceToTask(active);
    await appendManagedWorkspaceEvent({
      workspaceId: active.workspaceId,
      eventType: 'workspace.active',
      actor: input.createdBy,
      payload: { workspaceRoot: active.workspaceRoot },
    });
    return active;
  } catch (error) {
    const message = errorMessage(error);
    await updateManagedWorkspace(record.workspaceId, { status: 'failed', lastError: message });
    await appendManagedWorkspaceEvent({
      workspaceId: record.workspaceId,
      eventType: 'workspace.create_failed',
      actor: input.createdBy,
      payload: { error: message },
    });
    throw error;
  }
}

export async function backupManagedWorkspace(
  workspaceId: string,
  actor: string,
  options: ManagedWorkspaceRuntimeOptions,
): Promise<ManagedWorkspaceRecord> {
  const workspace = await requireActiveWorkspace(workspaceId);
  try {
    // 用**账本里记录的后端**捕获补丁（不是当前配置值 —— 配置可能已改，
    // 而这份隔离资源是当初那个后端建的）。补丁形态由后端决定。
    const backend = ISOLATION_BACKENDS[workspace.backend];
    if (!backend) throw new Error(`unknown isolation backend "${workspace.backend}" recorded on this workspace`);
    const patch = await backend.capturePatch({
      repository: workspace.sourceRoot, path: workspace.workspaceRoot,
    });
    const artifact = await putArtifact({
      artifactId: `workspace-backup-${workspace.workspaceId}-${randomUUID()}`,
      nodeId: options.nodeId ?? 'gateway-local',
      requestId: options.requestId,
      traceId: options.traceId,
      workspaceRoot: workspace.workspaceRoot,
      path: `${workspace.workspaceId}.patch`,
      pathPolicy: 'artifact-store',
      content: Buffer.from(patch, 'utf8'),
      contentType: 'text/x-diff',
      storageRoot: options.artifactStorageRoot,
      metadata: {
        managedWorkspaceId: workspace.workspaceId,
        graphId: workspace.graphId,
        taskId: workspace.taskId,
        projectId: workspace.projectId,
        baseRevision: workspace.baseRevision,
        backend: workspace.backend,
      },
    });
    const backedUp = await updateManagedWorkspace(workspace.workspaceId, {
      status: 'backup_ready',
      backupArtifactId: artifact.artifactId,
    });
    await appendManagedWorkspaceEvent({
      workspaceId: workspace.workspaceId,
      eventType: 'workspace.backup_created',
      actor,
      artifactId: artifact.artifactId,
      payload: { checksum: artifact.checksum, sizeBytes: artifact.sizeBytes },
    });
    return backedUp;
  } catch (error) {
    await recordFailure(workspace, actor, 'workspace.backup_failed', error);
    throw error;
  }
}

export async function releaseManagedWorkspace(
  workspaceId: string,
  actor: string,
  options: ManagedWorkspaceRuntimeOptions,
): Promise<ManagedWorkspaceRecord> {
  const backedUp = await backupManagedWorkspace(workspaceId, actor, options);
  const managedRoot = managedRootForSource(backedUp.sourceRoot, backedUp.projectId);
  assertManagedPath(backedUp.workspaceRoot, managedRoot);
  const actualRoot = await realpath(backedUp.workspaceRoot);
  if (actualRoot !== backedUp.workspaceRoot) throw new Error('managed workspace path changed since creation');

  try {
    // 委派给**记录在账本里**的那个后端（不是当前配置值 —— 配置可能已改，
    // 而这份隔离资源是当初那个后端建的）。
    const relBackend = ISOLATION_BACKENDS[backedUp.backend];
    if (!relBackend) throw new Error(`unknown isolation backend "${backedUp.backend}" recorded on this workspace`);
    // 目录移除**归后端**：`git worktree remove` 自己会删目录，jj 的
    // `workspace forget` 只解除登记。调用方若再统一 rm 一次，git 路径会因
    // 目录已不存在而 ENOENT，并被记成 release_failed（2026-10-08 实测踩到）。
    await relBackend.release({
      repository: backedUp.sourceRoot,
      path: backedUp.workspaceRoot,
      name: backedUp.workspaceName,
      backendState: {},
    });
    await clearManagedWorkspaceFromTask(backedUp);
    const released = await updateManagedWorkspace(backedUp.workspaceId, {
      status: 'released',
      backupArtifactId: backedUp.backupArtifactId,
      released: true,
    });
    await appendManagedWorkspaceEvent({
      workspaceId: released.workspaceId,
      eventType: 'workspace.released',
      actor,
      artifactId: released.backupArtifactId,
      payload: { removedPath: released.workspaceRoot },
    });
    return released;
  } catch (error) {
    await recordFailure(backedUp, actor, 'workspace.release_failed', error);
    throw error;
  }
}

/**
 * Return the raw jj diff (--git format) for an active managed workspace.
 * Returns an empty string when the workspace has no uncommitted changes.
 * Only active or backup_ready workspaces are accepted.
 */
export async function getWorkspaceDiff(workspaceId: string): Promise<string> {
  const workspace = await requireActiveWorkspace(workspaceId);
  if (workspace.status !== 'active' && workspace.status !== 'backup_ready') {
    throw new Error(`managed workspace status '${workspace.status}' does not support diff; expected active or backup_ready`);
  }
  const backend = ISOLATION_BACKENDS[workspace.backend];
  if (!backend) throw new Error(`unknown isolation backend "${workspace.backend}" recorded on this workspace`);
  return await backend.capturePatch({ repository: workspace.sourceRoot, path: workspace.workspaceRoot });
}

export function workspaceRootForTask(
  task: { metadata?: Record<string, unknown> },
  fallback?: string,
): string | undefined {
  const value = task.metadata?.workspaceRoot;
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function managedRootForSource(sourceRoot: string, projectId: string): string {
  return resolve(dirname(sourceRoot), '.los-managed-workspaces', safePathSegment(projectId));
}

function assertManagedPath(path: string, managedRoot: string): void {
  if (!isAbsolute(path)) throw new Error('managed workspace path must be absolute');
  const rel = relative(managedRoot, path);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new Error('managed workspace path escapes managed root');
  }
}

async function requireActiveWorkspace(workspaceId: string): Promise<ManagedWorkspaceRecord> {
  requireSafeId(workspaceId, 'workspaceId');
  const record = await loadManagedWorkspace(workspaceId);
  if (!record) throw new Error('managed workspace not found');
  if (record.status === 'released') throw new Error('managed workspace is already released');
  if (record.status === 'creating') throw new Error('managed workspace is still creating');
  return record;
}

async function recordFailure(record: ManagedWorkspaceRecord, actor: string, eventType: string, error: unknown): Promise<void> {
  const message = errorMessage(error);
  await updateManagedWorkspace(record.workspaceId, { status: 'failed', lastError: message });
  await appendManagedWorkspaceEvent({
    workspaceId: record.workspaceId,
    eventType,
    actor,
    payload: { error: message },
  });
}

async function runJj(repository: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('jj', ['--no-pager', '--color', 'never', '-R', repository, ...args], {
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT,
  });
  return stdout;
}

function safePathSegment(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, '-'); }
function requireSafeId(value: string, name: string): void { if (!SAFE_ID.test(value)) throw new Error(`${name} must be a safe identifier`); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
