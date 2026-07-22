import { randomUUID } from 'node:crypto';
import {
  createAgentTask,
  linkAgentTaskDependency,
  listAgentTasksForGraph,
  updateAgentTaskStatus,
  type AgentTaskRecord,
} from '../agent-task-graph.js';
import { editableSurfacesOverlap } from '../agent-task-editable-surfaces.js';
import { getAgentTaskGraphCompletion } from '../agent-task-graph-read-model.js';

export type GovernedAgentTaskGraphStatus = 'active' | 'cancelled' | 'integrated';
export type GovernedAgentTaskGraphIntegrationStatus = 'pending_verification' | 'ready' | 'integrated' | 'cancelled';

export interface GovernedGraphWorkerInput {
  id: string;
  title: string;
  prompt?: string;
  editableSurfaces: string[];
  priority?: number;
  maxAttempts?: number;
}

export interface CreateGovernedAgentTaskGraphInput {
  graphId: string;
  runSpecId: string;
  sessionId: string;
  integrationOwner: string;
  createdBy: string;
  workers: GovernedGraphWorkerInput[];
  verifier: Omit<GovernedGraphWorkerInput, 'editableSurfaces'>;
  maxParallelTasks?: number;
}

export interface GovernedAgentTaskGraphRecord {
  graphId: string;
  integrationOwner: string;
  status: GovernedAgentTaskGraphStatus;
  integrationStatus: GovernedAgentTaskGraphIntegrationStatus;
  metadata: Record<string, unknown>;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  integratedAt?: string;
  events: GovernedAgentTaskGraphEvent[];
}

export interface GovernedAgentTaskGraphEvent {
  eventId: string;
  graphId: string;
  eventType: string;
  actor: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

type GraphControlMetadata = {
  integrationOwner: string;
  status: GovernedAgentTaskGraphStatus;
  createdBy?: string;
  createdAt: string;
  integratedAt?: string;
  events: GovernedAgentTaskGraphEvent[];
  runSpecId: string;
  sessionId: string;
  workerTaskIds: string[];
  verifierTaskId: string;
  maxParallelTasks: number;
  editableSurfaceMode: 'require-declared';
  requireVerifier: true;
};

export async function createGovernedAgentTaskGraph(
  input: CreateGovernedAgentTaskGraphInput,
): Promise<GovernedAgentTaskGraphRecord> {
  validateCreateInput(input);
  if ((await listAgentTasksForGraph(input.graphId)).length > 0) throw new Error('agent task graph already exists');
  const now = new Date().toISOString();
  const maxParallelTasks = Math.min(input.workers.length, Math.max(2, Math.floor(input.maxParallelTasks ?? input.workers.length)));
  const metadata: GraphControlMetadata = {
    integrationOwner: input.integrationOwner,
    status: 'active',
    createdBy: input.createdBy,
    createdAt: now,
    events: [graphEvent(input.graphId, 'graph.created', input.createdBy, { maxParallelTasks }, now)],
    runSpecId: input.runSpecId,
    sessionId: input.sessionId,
    workerTaskIds: input.workers.map(worker => worker.id),
    verifierTaskId: input.verifier.id,
    maxParallelTasks,
    editableSurfaceMode: 'require-declared',
    requireVerifier: true,
  };

  try {
    for (const worker of input.workers) {
      await createAgentTask({
        id: worker.id,
        graphId: input.graphId,
        runSpecId: input.runSpecId,
        sessionId: input.sessionId,
        role: 'executor',
        title: worker.title,
        prompt: worker.prompt,
        priority: worker.priority,
        maxAttempts: worker.maxAttempts,
        metadata: {
          editableSurfaces: worker.editableSurfaces,
          runContract: { editableSurfaces: worker.editableSurfaces },
        },
      });
    }
    await createAgentTask({
      id: input.verifier.id,
      graphId: input.graphId,
      runSpecId: input.runSpecId,
      sessionId: input.sessionId,
      role: 'verifier',
      title: input.verifier.title,
      prompt: input.verifier.prompt,
      priority: input.verifier.priority,
      maxAttempts: input.verifier.maxAttempts,
      metadata: { graphControl: metadata },
    });
    for (const worker of input.workers) {
      await linkAgentTaskDependency({
        graphId: input.graphId,
        taskId: input.verifier.id,
        dependsOnTaskId: worker.id,
      });
    }
  } catch (error) {
    await cleanupFailedCreate(input.graphId);
    throw error;
  }
  return required(await loadGovernedAgentTaskGraph(input.graphId));
}

export async function loadGovernedAgentTaskGraph(graphId: string): Promise<GovernedAgentTaskGraphRecord | null> {
  const tasks = await listAgentTasksForGraph(graphId);
  const controlTask = tasks.find(task => graphControl(task));
  if (!controlTask) return null;
  const control = required(graphControl(controlTask));
  const completion = await getAgentTaskGraphCompletion(graphId, { requireVerifier: true });
  const integrationStatus: GovernedAgentTaskGraphIntegrationStatus = control.status === 'integrated'
    ? 'integrated'
    : control.status === 'cancelled'
      ? 'cancelled'
      : completion.canComplete ? 'ready' : 'pending_verification';
  return {
    graphId,
    integrationOwner: control.integrationOwner,
    status: control.status,
    integrationStatus,
    metadata: { ...control },
    createdBy: control.createdBy,
    createdAt: control.createdAt,
    updatedAt: controlTask.updatedAt,
    integratedAt: control.integratedAt,
    events: control.events,
  };
}

export async function cancelGovernedAgentTaskGraph(
  graphId: string,
  actor: string,
  reason: string,
): Promise<GovernedAgentTaskGraphRecord | null> {
  const graph = await loadGovernedAgentTaskGraph(graphId);
  if (!graph) return null;
  if (graph.status === 'integrated') throw new Error('integrated graph cannot be cancelled');
  const tasks = await listAgentTasksForGraph(graphId);
  const now = new Date().toISOString();
  const control = metadataFromRecord(graph, {
    status: 'cancelled',
    events: [...graph.events, graphEvent(graphId, 'graph.cancelled', actor, { reason }, now)],
  });
  for (const task of tasks) {
    if (task.status === 'queued' || task.status === 'running' || task.status === 'blocked') {
      await updateAgentTaskStatus(task.id, 'cancelled', {
        cancelReason: reason,
        cancelledBy: actor,
        ...(task.id === control.verifierTaskId ? { graphControl: control } : {}),
      });
    }
  }
  const verifier = tasks.find(task => task.id === control.verifierTaskId);
  if (verifier && verifier.status !== 'queued' && verifier.status !== 'running' && verifier.status !== 'blocked') {
    await updateAgentTaskStatus(verifier.id, verifier.status, { graphControl: control });
  }
  return required(await loadGovernedAgentTaskGraph(graphId));
}

export async function integrateGovernedAgentTaskGraph(
  graphId: string,
  actor: string,
  note?: string,
): Promise<GovernedAgentTaskGraphRecord | null> {
  const graph = await loadGovernedAgentTaskGraph(graphId);
  if (!graph) return null;
  if (graph.status === 'cancelled') throw new Error('cancelled graph cannot be integrated');
  if (graph.integrationOwner !== actor) throw new Error(`integration owner is ${graph.integrationOwner}`);
  const completion = await getAgentTaskGraphCompletion(graphId, { requireVerifier: true });
  if (!completion.canComplete) throw new Error(`verification gate blocks integration: ${completion.reason}`);
  const now = new Date().toISOString();
  const control = metadataFromRecord(graph, {
    status: 'integrated',
    integratedAt: graph.integratedAt ?? now,
    events: [...graph.events, graphEvent(graphId, 'graph.integrated', actor, {
      note: note ?? null,
      operatorIntervention: true,
    }, now)],
  });
  const updated = await updateAgentTaskStatus(control.verifierTaskId, 'succeeded', { graphControl: control });
  if (!updated) throw new Error('graph verifier task is unavailable');
  return required(await loadGovernedAgentTaskGraph(graphId));
}

function validateCreateInput(input: CreateGovernedAgentTaskGraphInput): void {
  for (const [name, value] of Object.entries({
    graphId: input.graphId,
    runSpecId: input.runSpecId,
    sessionId: input.sessionId,
    integrationOwner: input.integrationOwner,
    createdBy: input.createdBy,
  })) if (!value.trim()) throw new Error(`${name} is required`);
  if (input.workers.length < 2 || input.workers.length > 4) throw new Error('governed graph requires 2 to 4 executor workers');
  if (input.maxParallelTasks !== undefined && (input.maxParallelTasks < 2 || input.maxParallelTasks > 4)) {
    throw new Error('maxParallelTasks must be between 2 and 4');
  }
  const ids = new Set<string>();
  for (const task of [...input.workers, input.verifier]) {
    if (!task.id.trim() || ids.has(task.id)) throw new Error('graph task ids must be non-empty and unique');
    if (!task.title.trim()) throw new Error(`task ${task.id} title is required`);
    ids.add(task.id);
  }
  const claimed: string[] = [];
  for (const worker of input.workers) {
    const surfaces = [...new Set(worker.editableSurfaces.map(value => value.trim()).filter(Boolean))];
    if (surfaces.length === 0) throw new Error(`executor ${worker.id} must declare editable surfaces`);
    const conflict = surfaces.find(surface => claimed.some(existing => editableSurfacesOverlap(existing, surface)));
    if (conflict) throw new Error(`editable surface conflict: ${conflict}`);
    worker.editableSurfaces = surfaces;
    claimed.push(...surfaces);
  }
}

function graphControl(task: AgentTaskRecord): GraphControlMetadata | null {
  const value = task.metadata.graphControl;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const control = value as Partial<GraphControlMetadata>;
  if (!control.integrationOwner || !control.verifierTaskId || !control.runSpecId) return null;
  return {
    integrationOwner: control.integrationOwner,
    status: control.status === 'cancelled' || control.status === 'integrated' ? control.status : 'active',
    createdBy: control.createdBy,
    createdAt: control.createdAt ?? task.createdAt,
    integratedAt: control.integratedAt,
    events: Array.isArray(control.events) ? control.events : [],
    runSpecId: control.runSpecId,
    sessionId: control.sessionId ?? task.sessionId ?? '',
    workerTaskIds: Array.isArray(control.workerTaskIds) ? control.workerTaskIds : [],
    verifierTaskId: control.verifierTaskId,
    maxParallelTasks: Number(control.maxParallelTasks) || 2,
    editableSurfaceMode: 'require-declared',
    requireVerifier: true,
  };
}

function metadataFromRecord(
  graph: GovernedAgentTaskGraphRecord,
  update: Partial<GraphControlMetadata>,
): GraphControlMetadata {
  return { ...(graph.metadata as unknown as GraphControlMetadata), ...update };
}

function graphEvent(
  graphId: string,
  eventType: string,
  actor: string,
  payload: Record<string, unknown>,
  createdAt: string,
): GovernedAgentTaskGraphEvent {
  return { eventId: `graph-event-${randomUUID()}`, graphId, eventType, actor, payload, createdAt };
}

async function cleanupFailedCreate(graphId: string): Promise<void> {
  const { getDb } = await import('@los/infra/db');
  await getDb().query('DELETE FROM task_edges WHERE graph_id = $1', [graphId]).catch(() => undefined);
  await getDb().query('DELETE FROM agent_tasks WHERE graph_id = $1', [graphId]).catch(() => undefined);
}

function required<T>(value: T | null): T { if (!value) throw new Error('agent task graph missing'); return value; }
