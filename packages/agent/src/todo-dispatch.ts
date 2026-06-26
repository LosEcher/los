/**
 * @los/agent/todo-dispatch — Core todo dispatch logic.
 *
 * Centralizes the gate checks + scheduler handoff for dispatching a todo
 * as a scheduled agent task. Shared by:
 *   - gateway route `POST /todos/:id/dispatch` (todo-routes.ts)
 *   - gateway in-process MessageRouter (`#run` / `#dispatch` commands)
 *
 * wechat-bot reaches the same behavior cross-process via HTTP.
 *
 * Gates (ADR 0005):
 *   1. status gate — todo must be `ready` (override with `force: true`)
 *   2. kind gate   — todo must be `task` or `batch`
 *   3. dep gate    — all `dependsOnIds` must be `done`
 *
 * On success the todo is transitioned to `in_progress` before the agent
 * loop fires; the `onTaskEvent` callback maps task lifecycle events back
 * to todo status transitions (succeeded→done, failed/blocked→blocked,
 * cancelled→cancelled).
 */

import { randomUUID } from 'node:crypto';
import type { ScheduledTaskEvent } from './scheduler/types.js';
import { runScheduledAgentTask } from './scheduler/scheduled-task-runner.js';
import { loadTodo, updateTodo, type TodoRecord } from './todos.js';

export type DispatchToolMode = 'read-only' | 'project-write' | 'all';

export interface DispatchTodoOptions {
  /** Override the `ready` status gate. */
  force?: boolean;
  /** Tool permission mode for the agent run. Defaults to `read-only`. */
  toolMode?: DispatchToolMode;
  /** Workspace root for the agent run. Defaults to `process.cwd()`. */
  workspaceRoot?: string;
}

export interface DispatchTodoResult {
  todo: TodoRecord;
  taskRun: unknown;
  schedulerStatus: string;
}

/**
 * Error thrown when a dispatch gate fails. `status` is the HTTP status the
 * gateway route should return; callers that are not HTTP-bound may inspect
 * `code` instead.
 */
export class DispatchError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DispatchError';
  }
}

const VALID_TOOL_MODES: readonly DispatchToolMode[] = ['read-only', 'project-write', 'all'];

/**
 * Dispatch a todo by id: validate gates, transition to in_progress, and fire
 * the scheduled agent task. Resolves with the reloaded todo + created task_run
 * as soon as the task_run exists (the agent loop continues asynchronously;
 * `onTaskEvent` updates the todo status as the task progresses).
 */
export async function dispatchTodo(
  id: string,
  opts: DispatchTodoOptions = {},
): Promise<DispatchTodoResult> {
  const todo = await loadTodo(id);
  if (!todo) {
    throw new DispatchError(404, 'not_found', `Todo "${id}" not found`);
  }

  // 1. Status gate
  if (todo.status !== 'ready' && !opts.force) {
    throw new DispatchError(
      400,
      'todo_not_ready',
      `Todo status is "${todo.status}", must be "ready". Use force=true to override.`,
    );
  }

  // 2. Kind gate (ADR 0005)
  if (todo.kind !== 'task' && todo.kind !== 'batch') {
    throw new DispatchError(
      400,
      'todo_not_dispatchable',
      `Todo kind "${todo.kind}" cannot be dispatched. Only task and batch are eligible.`,
    );
  }

  // 3. Dependency gate
  if (todo.dependsOnIds && todo.dependsOnIds.length > 0) {
    const incomplete: string[] = [];
    for (const depId of todo.dependsOnIds) {
      const dep = await loadTodo(depId);
      if (dep && dep.status !== 'done') incomplete.push(depId);
    }
    if (incomplete.length > 0) {
      throw new DispatchError(
        400,
        'todo_dependencies_not_met',
        `${incomplete.length} dependencies not done`,
        { incompleteIds: incomplete },
      );
    }
  }

  const sessionId = todo.sessionId ?? `dispatch-${randomUUID()}`;
  const prompt = todo.description || todo.title;
  const toolMode: DispatchToolMode = VALID_TOOL_MODES.includes(opts.toolMode as DispatchToolMode)
    ? (opts.toolMode as DispatchToolMode)
    : 'read-only';

  // Transition todo to in_progress before firing the scheduler
  await updateTodo(id, { status: 'in_progress' });

  // Fire-and-forget: runScheduledAgentTask handles the full lifecycle
  // (create task_run, transition queued→running, execute agent loop).
  // The onTaskEvent callback updates the todo status asynchronously.
  const scheduledPromise = runScheduledAgentTask({
    prompt,
    sessionId,
    runSpecId: todo.metadata?.runSpecId as string | undefined,
    workspaceRoot: opts.workspaceRoot ?? process.cwd(),
    toolMode,
    promptPreview: todo.title,
    tenantId: todo.tenantId,
    projectId: todo.projectId,
    userId: todo.userId,
    metadata: { ...todo.metadata, dispatchSource: 'todo', todoId: id },
    onTaskEvent: async (event: ScheduledTaskEvent) => {
      // Map task lifecycle events to todo status transitions
      if (event.type === 'task.failed' || event.type === 'task.blocked') {
        await updateTodo(id, {
          status: 'blocked',
          taskRunId: event.taskRun.id,
          sessionId: event.taskRun.sessionId,
          metadata: {
            ...todo.metadata,
            dispatchReady: false,
            lastRun: {
              event: event.type,
              status: event.taskRun.status,
              sessionId: event.taskRun.sessionId,
              taskRunId: event.taskRun.id,
              traceId: event.taskRun.traceId,
              reason: 'Task execution failed or blocked',
              updatedAt: new Date().toISOString(),
            },
          },
        }).catch(() => undefined);
      } else if (event.type === 'task.succeeded') {
        await updateTodo(id, {
          status: 'done',
          taskRunId: event.taskRun.id,
          sessionId: event.taskRun.sessionId,
        }).catch(() => undefined);
      } else if (event.type === 'task.cancelled') {
        await updateTodo(id, {
          status: 'cancelled',
          taskRunId: event.taskRun.id,
          sessionId: event.taskRun.sessionId,
          metadata: {
            ...todo.metadata,
            cancelReason: 'Task cancelled during execution',
          },
        }).catch(() => undefined);
      } else if (event.type === 'task.running') {
        await updateTodo(id, {
          taskRunId: event.taskRun.id,
          sessionId: event.taskRun.sessionId,
        }).catch(() => undefined);
      }
    },
  });

  // runScheduledAgentTask creates the task_run synchronously before entering
  // the async agent loop, so we can extract it quickly for the response.
  const result = await scheduledPromise;
  const taskRun = 'taskRun' in result ? result.taskRun : null;

  const reloaded = await loadTodo(id);
  return { todo: reloaded ?? todo, taskRun, schedulerStatus: result.status };
}
