import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { putArtifact } from './artifacts.js';
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
  await runJj(sourceRoot, ['root']);

  const managedRoot = managedRootForSource(sourceRoot, input.projectId);
  const workspaceRoot = resolve(managedRoot, input.workspaceId);
  assertManagedPath(workspaceRoot, managedRoot);
  const workspaceName = `los-${input.workspaceId}`;
  const baseRevision = (await runJj(sourceRoot, ['log', '-r', '@-', '--no-graph', '-T', 'commit_id.short(12)'])).trim();
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
    vcsKind: 'jj',
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
    await runJj(sourceRoot, [
      'workspace', 'add', '--name', workspaceName, '-r', '@-',
      '-m', `los managed workspace for ${input.graphId}/${input.taskId}`,
      workspaceRoot,
    ]);
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
    const patch = await runJj(workspace.workspaceRoot, ['diff', '--git']);
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
        vcsKind: workspace.vcsKind,
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
    await runJj(backedUp.sourceRoot, ['workspace', 'forget', backedUp.workspaceName]);
    await rm(backedUp.workspaceRoot, { recursive: true, force: false });
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
