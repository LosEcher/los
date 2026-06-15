import type { FastifyInstance } from 'fastify';
import {
  createTaskRun,
} from '@los/agent/task-runs';
import { runScheduledAgentTask } from '@los/agent/scheduler';
import {
  archiveTodo,
  createTodo,
  listTodos,
  loadTodo,
  reopenTodo,
  seedLosPlanningTodos,
  unarchiveTodo,
  updateTodo,
  type TodoKind,
  type TodoPriority,
  type TodoStatus,
} from '@los/agent/todos';
import { randomUUID } from 'node:crypto';
import { getRequestContext } from '../request-context.js';
import { runIdempotentJson } from '../idempotency.js';

export function registerTodoRoutes(app: FastifyInstance) {
  app.get('/todos', async (req) => {
    const query = req.query as {
      tenantId?: string;
      projectId?: string;
      status?: TodoStatus;
      kind?: TodoKind;
      stageId?: string;
      source?: string;
      traceId?: string;
      requestId?: string;
      taskRunId?: string;
      sessionId?: string;
      batchKey?: string;
      limit?: string;
      includeArchived?: string;
    };
    return await listTodos({
      tenantId: normalizeOptionalString(query.tenantId),
      projectId: normalizeOptionalString(query.projectId),
      status: normalizeTodoStatus(query.status),
      kind: normalizeTodoKind(query.kind),
      stageId: normalizeOptionalString(query.stageId),
      source: normalizeOptionalString(query.source),
      traceId: normalizeOptionalString(query.traceId),
      requestId: normalizeOptionalString(query.requestId),
      taskRunId: normalizeOptionalString(query.taskRunId),
      sessionId: normalizeOptionalString(query.sessionId),
      batchKey: normalizeOptionalString(query.batchKey),
      limit: normalizePositiveInteger(query.limit) ?? 100,
      includeArchived: normalizeBoolean(query.includeArchived),
    });
  });

  app.post('/todos', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const title = normalizeOptionalString(body.title);
    if (!title) return reply.status(400).send({ error: 'title is required' });

    const context = getRequestContext(req);
    return await runIdempotentJson(
      req,
      reply,
      { route: '/todos', method: 'POST', body, context },
      async () => await createTodo({
        title,
        description: normalizeOptionalString(body.description),
        tenantId: normalizeOptionalString(body.tenantId) ?? context.tenantId,
        projectId: normalizeOptionalString(body.projectId) ?? context.projectId,
        userId: normalizeOptionalString(body.userId),
        nodeId: normalizeOptionalString(body.nodeId),
        stageId: normalizeOptionalString(body.stageId),
        parentId: normalizeOptionalString(body.parentId),
        kind: normalizeTodoKind(body.kind) ?? 'task',
        status: normalizeTodoStatus(body.status) ?? 'backlog',
        priority: normalizeTodoPriority(body.priority) ?? 'P2',
        source: normalizeOptionalString(body.source) ?? 'web-console',
        traceId: normalizeOptionalString(body.traceId) ?? context.traceId,
        requestId: normalizeOptionalString(body.requestId) ?? context.requestId,
        dedupeKey: normalizeOptionalString(body.dedupeKey),
        taskRunId: normalizeOptionalString(body.taskRunId),
        sessionId: normalizeOptionalString(body.sessionId),
        batchKey: normalizeOptionalString(body.batchKey),
        dependsOnIds: normalizeStringArray(body.dependsOnIds),
        metadata: normalizeObject(body.metadata),
      }),
    );
  });

  app.patch('/todos/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const context = getRequestContext(req);
    return await runIdempotentJson(
      req,
      reply,
      { route: `/todos/${id}`, method: 'PATCH', body, context },
      async () => {
        const todo = await updateTodo(id, {
          title: normalizeOptionalString(body.title),
          description: normalizeOptionalString(body.description),
          kind: normalizeTodoKind(body.kind),
          status: normalizeTodoStatus(body.status),
          priority: normalizeTodoPriority(body.priority),
          userId: normalizeNullableString(body.userId),
          nodeId: normalizeNullableString(body.nodeId),
          stageId: normalizeNullableString(body.stageId),
          parentId: normalizeNullableString(body.parentId),
          traceId: normalizeNullableString(body.traceId) ?? context.traceId,
          requestId: normalizeNullableString(body.requestId) ?? context.requestId,
          dedupeKey: normalizeNullableString(body.dedupeKey),
          taskRunId: normalizeNullableString(body.taskRunId),
          sessionId: normalizeNullableString(body.sessionId),
          batchKey: normalizeNullableString(body.batchKey),
          dependsOnIds: body.dependsOnIds === undefined ? undefined : normalizeStringArray(body.dependsOnIds) ?? [],
          metadata: body.metadata === undefined ? undefined : normalizeObject(body.metadata),
        });
        if (!todo) {
          reply.status(404);
          return { error: 'Not found' };
        }
        return todo;
      },
    );
  });

  app.post('/todos/:id/reopen', async (req, reply) => {
    const { id } = req.params as { id: string };
    const context = getRequestContext(req);
    return await runIdempotentJson(
      req,
      reply,
      { route: `/todos/${id}/reopen`, method: 'POST', body: req.body ?? {}, context },
      async () => {
        const todo = await reopenTodo(id);
        if (!todo) {
          reply.status(404);
          return { error: 'Not found' };
        }
        return todo;
      },
    );
  });

  app.post('/todos/:id/archive', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown> | undefined;
    const context = getRequestContext(req);
    return await runIdempotentJson(
      req,
      reply,
      { route: `/todos/${id}/archive`, method: 'POST', body: body ?? {}, context },
      async () => {
        const todo = await archiveTodo(id, normalizeOptionalString(body?.reason));
        if (!todo) {
          reply.status(404);
          return { error: 'Not found' };
        }
        return todo;
      },
    );
  });

  app.post('/todos/:id/unarchive', async (req, reply) => {
    const { id } = req.params as { id: string };
    const context = getRequestContext(req);
    return await runIdempotentJson(
      req,
      reply,
      { route: `/todos/${id}/unarchive`, method: 'POST', body: req.body ?? {}, context },
      async () => {
        const todo = await unarchiveTodo(id);
        if (!todo) {
          reply.status(404);
          return { error: 'Not found' };
        }
        return todo;
      },
    );
  });

  app.post('/todos/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown> | undefined;
    const context = getRequestContext(req);
    return await runIdempotentJson(
      req,
      reply,
      { route: `/todos/${id}/cancel`, method: 'POST', body: body ?? {}, context },
      async () => {
        const existing = await loadTodo(id);
        if (!existing) {
          reply.status(404);
          return { error: 'Not found' };
        }
        return await updateTodo(id, {
          status: 'cancelled',
          metadata: {
            ...existing.metadata,
            cancelReason: normalizeOptionalString(body?.reason) ?? 'cancelled_from_todo',
          },
        });
      },
    );
  });

  app.post('/todos/seed', async (req) => {
    const body = req.body as Record<string, unknown> | undefined;
    const todos = await seedLosPlanningTodos({ overwrite: body?.overwrite === true });
    return { ok: true, count: todos.length, todos };
  });

  app.post('/todos/:id/dispatch', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown> | undefined;
    const context = getRequestContext(req);

    return await runIdempotentJson(
      req,
      reply,
      { route: `/todos/${id}/dispatch`, method: 'POST', body: body ?? {}, context },
      async () => {
        const todo = await loadTodo(id);
        if (!todo) {
          reply.status(404);
          return { error: 'Not found' };
        }

        const force = body?.force === true;
        if (todo.status !== 'ready' && !force) {
          reply.status(400);
          return { error: 'todo_not_ready', message: `Todo status is "${todo.status}", must be "ready". Use force=true to override.` };
        }

        // Kind gate: only task and batch are dispatchable (ADR 0005)
        if (todo.kind !== 'task' && todo.kind !== 'batch') {
          reply.status(400);
          return { error: 'todo_not_dispatchable', message: `Todo kind "${todo.kind}" cannot be dispatched. Only task and batch are eligible.` };
        }

        // Dependency gate: all dependsOnIds must be done
        if (todo.dependsOnIds && todo.dependsOnIds.length > 0) {
          const incomplete: string[] = [];
          for (const depId of todo.dependsOnIds) {
            const dep = await loadTodo(depId);
            if (dep && dep.status !== 'done') incomplete.push(depId);
          }
          if (incomplete.length > 0) {
            reply.status(400);
            return {
              error: 'todo_dependencies_not_met',
              message: `${incomplete.length} dependencies not done`,
              incompleteIds: incomplete,
            };
          }
        }

        const sessionId = todo.sessionId ?? `dispatch-${randomUUID()}`;
        const prompt = todo.description || todo.title;

        // Transition todo to in_progress before firing the scheduler
        await updateTodo(id, { status: 'in_progress' });

        // Fire-and-forget: runScheduledAgentTask handles the full lifecycle
        // (create task_run, transition queued→running, execute agent loop).
        // The onTaskEvent callback updates the todo status asynchronously.
        const scheduledPromise = runScheduledAgentTask({
          prompt,
          sessionId,
          runSpecId: todo.metadata?.runSpecId as string | undefined,
          workspaceRoot: (body?.workspaceRoot as string) ?? process.cwd(),
          toolMode: (['read-only', 'project-write', 'all'].includes(body?.toolMode as string) ? body?.toolMode : 'read-only') as 'read-only' | 'project-write' | 'all',
          promptPreview: todo.title,
          tenantId: todo.tenantId,
          projectId: todo.projectId,
          userId: todo.userId,
          metadata: { ...todo.metadata, dispatchSource: 'todo', todoId: id },
          onTaskEvent: async (event) => {
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

        // Resolve the task_run ID as soon as possible for the response.
        // runScheduledAgentTask creates the task_run synchronously before
        // entering the async agent loop, so we can extract it quickly.
        const result = await scheduledPromise;
        const taskRun = 'taskRun' in result ? result.taskRun : null;

        return { todo: await loadTodo(id), taskRun, schedulerStatus: result.status };
      },
    );
  });
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return normalizeOptionalString(value);
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return undefined;
    const int = Math.floor(parsed);
    return int > 0 ? int : undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const int = Math.floor(value);
  return int > 0 ? int : undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return undefined;
}

function normalizeTodoStatus(value: unknown): TodoStatus | undefined {
  if (value === 'backlog' || value === 'ready' || value === 'in_progress' || value === 'blocked' || value === 'done' || value === 'cancelled') return value;
  return undefined;
}

function normalizeTodoKind(value: unknown): TodoKind | undefined {
  if (value === 'problem' || value === 'solution' || value === 'plan' || value === 'phase' || value === 'task' || value === 'batch') return value;
  return undefined;
}

function normalizeTodoPriority(value: unknown): TodoPriority | undefined {
  if (value === 'P0' || value === 'P1' || value === 'P2' || value === 'P3') return value;
  return undefined;
}

function normalizeObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.map(normalizeOptionalString).filter((item): item is string => Boolean(item));
    return items.length > 0 ? Array.from(new Set(items)) : undefined;
  }
  if (typeof value === 'string') {
    const items = value.split(',').map(normalizeOptionalString).filter((item): item is string => Boolean(item));
    return items.length > 0 ? Array.from(new Set(items)) : undefined;
  }
  return undefined;
}
