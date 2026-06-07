import {
  listAgentTaskAttempts,
  listAgentTaskEdgesForGraph,
  listAgentTasksForGraph,
  type AgentTaskAttemptRecord,
  type AgentTaskEdgeRecord,
  type AgentTaskRecord,
} from './agent-task-graph.js';

export type AgentTaskGraphCompletionStatus =
  | 'empty'
  | 'in_progress'
  | 'blocked'
  | 'failed'
  | 'succeeded';

export type AgentTaskGraphBlockReason =
  | 'dependency_failure'
  | 'verifier_required';

export interface AgentTaskGraphCompletionOptions {
  requireVerifier?: boolean;
}

export interface AgentTaskGraphCompletion {
  graphId: string;
  status: AgentTaskGraphCompletionStatus;
  canComplete: boolean;
  reason: string;
  blockReason?: AgentTaskGraphBlockReason;
  counts: {
    total: number;
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    verifier: number;
    succeededVerifier: number;
  };
  readyTaskIds: string[];
  waitingTaskIds: string[];
  blockedTaskIds: string[];
  runningTaskIds: string[];
  failedTaskIds: string[];
  failedVerifierTaskIds: string[];
  cancelledTaskIds: string[];
  verifierTaskIds: string[];
  succeededVerifierTaskIds: string[];
}

export interface AgentTaskGraphReadModel {
  graphId: string;
  tasks: AgentTaskRecord[];
  edges: AgentTaskEdgeRecord[];
  attemptsByTaskId: Record<string, AgentTaskAttemptRecord[]>;
  completion: AgentTaskGraphCompletion;
}

export async function readAgentTaskGraph(
  graphId: string,
  options: AgentTaskGraphCompletionOptions = {},
): Promise<AgentTaskGraphReadModel> {
  const tasks = await listAgentTasksForGraph(graphId);
  const edges = await listAgentTaskEdgesForGraph(graphId);
  const attemptsByTaskId: Record<string, AgentTaskAttemptRecord[]> = {};
  await Promise.all(tasks.map(async task => {
    attemptsByTaskId[task.id] = await listAgentTaskAttempts(task.id);
  }));
  return {
    graphId,
    tasks,
    edges,
    attemptsByTaskId,
    completion: summarizeAgentTaskGraph(graphId, tasks, edges, options),
  };
}

export async function getAgentTaskGraphCompletion(
  graphId: string,
  options: AgentTaskGraphCompletionOptions = {},
): Promise<AgentTaskGraphCompletion> {
  const tasks = await listAgentTasksForGraph(graphId);
  const edges = await listAgentTaskEdgesForGraph(graphId);
  return summarizeAgentTaskGraph(graphId, tasks, edges, options);
}

export function summarizeAgentTaskGraph(
  graphId: string,
  tasks: readonly AgentTaskRecord[],
  edges: readonly AgentTaskEdgeRecord[],
  options: AgentTaskGraphCompletionOptions = {},
): AgentTaskGraphCompletion {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const depsByTask = new Map<string, AgentTaskEdgeRecord[]>();
  for (const edge of edges) {
    const list = depsByTask.get(edge.taskId) ?? [];
    list.push(edge);
    depsByTask.set(edge.taskId, list);
  }

  const readyTaskIds: string[] = [];
  const waitingTaskIds: string[] = [];
  const blockedTaskIds: string[] = [];
  const runningTaskIds: string[] = [];
  const failedTaskIds: string[] = [];
  const failedVerifierTaskIds: string[] = [];
  const cancelledTaskIds: string[] = [];
  const verifierTaskIds: string[] = [];
  const succeededVerifierTaskIds: string[] = [];

  for (const task of tasks) {
    if (task.role === 'verifier') verifierTaskIds.push(task.id);
    if (task.role === 'verifier' && task.status === 'succeeded') succeededVerifierTaskIds.push(task.id);
    if (task.role === 'verifier' && task.status === 'failed') failedVerifierTaskIds.push(task.id);
    if (task.status === 'running') runningTaskIds.push(task.id);
    if (task.status === 'failed') failedTaskIds.push(task.id);
    if (task.status === 'cancelled') cancelledTaskIds.push(task.id);
    if (task.status !== 'queued') continue;

    const deps = depsByTask.get(task.id) ?? [];
    const hasFailedDependency = deps.some(edge => {
      const upstream = byId.get(edge.dependsOnTaskId);
      return upstream?.status === 'failed' || upstream?.status === 'cancelled';
    });
    if (hasFailedDependency) {
      blockedTaskIds.push(task.id);
      continue;
    }

    const dependenciesMet = deps.every(edge => byId.get(edge.dependsOnTaskId)?.status === 'succeeded');
    if (dependenciesMet) {
      readyTaskIds.push(task.id);
    } else {
      waitingTaskIds.push(task.id);
    }
  }

  const counts = {
    total: tasks.length,
    queued: tasks.filter(task => task.status === 'queued').length,
    running: runningTaskIds.length,
    succeeded: tasks.filter(task => task.status === 'succeeded').length,
    failed: failedTaskIds.length,
    cancelled: cancelledTaskIds.length,
    verifier: verifierTaskIds.length,
    succeededVerifier: succeededVerifierTaskIds.length,
  };

  if (tasks.length === 0) {
    return completion('empty', false, 'graph has no tasks');
  }
  if (blockedTaskIds.length > 0) {
    return completion('blocked', false, 'failed dependency blocks downstream tasks', 'dependency_failure');
  }
  if (failedVerifierTaskIds.length > 0) {
    return completion('blocked', false, 'verifier task failed required checks', 'verifier_required');
  }
  if (failedTaskIds.length > 0 || cancelledTaskIds.length > 0) {
    return completion('failed', false, 'terminal task failure requires retry or operator action');
  }
  if (runningTaskIds.length > 0) {
    return completion('in_progress', false, 'tasks are still running');
  }
  if (readyTaskIds.length > 0) {
    return completion('in_progress', false, 'ready tasks remain unclaimed');
  }
  if (waitingTaskIds.length > 0) {
    return completion('in_progress', false, 'queued tasks are waiting for dependencies');
  }
  if (options.requireVerifier && succeededVerifierTaskIds.length === 0) {
    return completion('blocked', false, 'succeeded verifier task is required for completion', 'verifier_required');
  }
  return completion('succeeded', true, 'all tasks succeeded');

  function completion(
    status: AgentTaskGraphCompletionStatus,
    canComplete: boolean,
    reason: string,
    blockReason?: AgentTaskGraphBlockReason,
  ): AgentTaskGraphCompletion {
    return {
      graphId,
      status,
      canComplete,
      reason,
      blockReason,
      counts,
      readyTaskIds,
      waitingTaskIds,
      blockedTaskIds,
      runningTaskIds,
      failedTaskIds,
      failedVerifierTaskIds,
      cancelledTaskIds,
      verifierTaskIds,
      succeededVerifierTaskIds,
    };
  }
}
