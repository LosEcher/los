import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  backupManagedWorkspace,
  createManagedWorkspace,
  editableSurfacesForAgentTask,
  editableSurfacesOverlap,
  listManagedWorkspaces,
  loadManagedWorkspaceDetail,
  readAgentTaskGraph,
  releaseManagedWorkspace,
  type AgentTaskRecord,
} from '@los/agent';
import { getProject } from '../../project-store.js';
import { getRequestContext, requireOperator } from '../../request-context.js';

export interface ManagedWorkspaceRouteOptions {
  artifactStorageRoot: string;
}

export function registerManagedWorkspaceRoutes(app: FastifyInstance, options: ManagedWorkspaceRouteOptions): void {
  app.get('/agent-graphs/:id/workspace-plan', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { projectId?: string };
    const projectId = normalizeString(query.projectId) ?? getRequestContext(req).projectId;
    const project = getProject(projectId);
    if (!project) return reply.status(404).send({ error: 'project binding not found' });
    const graph = await readAgentTaskGraph(id);
    return buildWorkspacePlan(id, projectId, graph.tasks);
  });

  app.post('/agent-graphs/:id/workspaces', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { projectId?: string; taskIds?: string[] };
    const context = getRequestContext(req);
    const projectId = normalizeString(body.projectId) ?? context.projectId;
    const project = getProject(projectId);
    if (!project) return reply.status(404).send({ error: 'project binding not found' });
    const graph = await readAgentTaskGraph(id);
    const plan = buildWorkspacePlan(id, projectId, graph.tasks);
    const requestedIds = uniqueStrings(body.taskIds);
    const selected = requestedIds.length > 0
      ? requestedIds.map(taskId => plan.tasks.find(task => task.taskId === taskId))
      : plan.tasks.filter(task => task.eligible);
    if (selected.some(task => !task)) return reply.status(404).send({ error: 'requested task not found in graph' });
    const invalid = selected.filter(task => !task?.eligible);
    if (invalid.length > 0) {
      return reply.status(409).send({ error: 'tasks are not eligible for workspace allocation', tasks: invalid });
    }

    const results: Array<{ taskId: string; workspace?: unknown; error?: string }> = [];
    for (const taskPlan of selected) {
      if (!taskPlan) continue;
      try {
        const workspace = await createManagedWorkspace({
          workspaceId: `workspace-${randomUUID()}`,
          graphId: id,
          taskId: taskPlan.taskId,
          projectId,
          sourceRoot: project.workspacePath,
          createdBy: context.userId,
          metadata: { editableSurfaces: taskPlan.editableSurfaces },
        });
        results.push({ taskId: taskPlan.taskId, workspace });
      } catch (error) {
        results.push({ taskId: taskPlan.taskId, error: errorMessage(error) });
      }
    }
    const hasFailure = results.some(result => result.error);
    return reply.status(hasFailure ? 207 : 201).send({ graphId: id, projectId, results });
  });

  app.get('/managed-workspaces', async (req) => {
    const query = req.query as { graphId?: string; taskId?: string; projectId?: string; status?: string; limit?: string };
    return await listManagedWorkspaces({
      graphId: normalizeString(query.graphId),
      taskId: normalizeString(query.taskId),
      projectId: normalizeString(query.projectId),
      status: normalizeStatus(query.status),
      limit: normalizeLimit(query.limit),
    });
  });

  app.get('/managed-workspaces/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const detail = await loadManagedWorkspaceDetail(id);
    if (!detail) return reply.status(404).send({ error: 'managed workspace not found' });
    return detail;
  });

  app.post('/managed-workspaces/:id/backup', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const { id } = req.params as { id: string };
    if (!(await loadManagedWorkspaceDetail(id))) return reply.status(404).send({ error: 'managed workspace not found' });
    const context = getRequestContext(req);
    return await backupManagedWorkspace(id, context.userId, runtimeOptions(options, context));
  });

  app.post('/managed-workspaces/:id/release', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { confirm?: string };
    if (body.confirm !== id) return reply.status(409).send({ error: 'confirm must exactly match workspace id' });
    if (!(await loadManagedWorkspaceDetail(id))) return reply.status(404).send({ error: 'managed workspace not found' });
    const context = getRequestContext(req);
    return await releaseManagedWorkspace(id, context.userId, runtimeOptions(options, context));
  });
}

type WorkspacePlanTask = {
  taskId: string;
  title: string;
  role: AgentTaskRecord['role'];
  status: AgentTaskRecord['status'];
  editableSurfaces: string[];
  eligible: boolean;
  reason?: string;
};

function buildWorkspacePlan(graphId: string, projectId: string, tasks: AgentTaskRecord[]) {
  const selectedSurfaces: string[] = [];
  const planned: WorkspacePlanTask[] = tasks.map(task => {
    const editableSurfaces = editableSurfacesForAgentTask(task);
    let reason: string | undefined;
    if (task.role !== 'executor') reason = 'only executor tasks can receive managed workspaces';
    else if (task.status !== 'queued') reason = 'task must be queued';
    else if (typeof task.metadata.managedWorkspaceId === 'string') reason = 'task already has a managed workspace';
    else if (editableSurfaces.length === 0) reason = 'task must declare editable surfaces';
    else if (editableSurfaces.some(surface => selectedSurfaces.some(existing => editableSurfacesOverlap(existing, surface)))) {
      reason = 'editable surfaces overlap another eligible task';
    }
    if (!reason) selectedSurfaces.push(...editableSurfaces);
    return {
      taskId: task.id,
      title: task.title,
      role: task.role,
      status: task.status,
      editableSurfaces,
      eligible: !reason,
      reason,
    };
  });
  return { graphId, projectId, tasks: planned, eligibleTaskIds: planned.filter(task => task.eligible).map(task => task.taskId) };
}

function runtimeOptions(options: ManagedWorkspaceRouteOptions, context: ReturnType<typeof getRequestContext>) {
  return {
    artifactStorageRoot: options.artifactStorageRoot,
    requestId: context.requestId,
    traceId: context.traceId,
  };
}

function uniqueStrings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(normalizeString).filter((item): item is string => Boolean(item)))] : [];
}
function normalizeString(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function normalizeLimit(value: unknown): number | undefined { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined; }
function normalizeStatus(value: unknown): 'creating' | 'active' | 'backup_ready' | 'released' | 'failed' | undefined {
  return value === 'creating' || value === 'active' || value === 'backup_ready' || value === 'released' || value === 'failed' ? value : undefined;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
