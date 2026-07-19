import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { getDb } from '@los/infra/db';
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
