import {
  archiveTodo,
  createTodo,
  listTodos,
  loadTodo,
  reopenTodo,
  updateTodo,
  type TodoKind,
  type TodoPriority,
  type TodoStatus,
} from '../todos.js';
import type { ToolRegistry } from './registry.js';

export function registerTodoTools(registry: ToolRegistry): void {
  registry.register('todo_list', async (args) => {
    const todos = await listTodos({
      tenantId: normalizeToolString(args.tenantId),
      projectId: normalizeToolString(args.projectId),
      status: normalizeToolTodoStatus(args.status),
      kind: normalizeToolTodoKind(args.kind),
      limit: normalizeToolNumber(args.limit),
      includeArchived: args.includeArchived === true,
    });
    return { content: JSON.stringify(todos, null, 2) };
  }, {
    type: 'function',
    function: {
      name: 'todo_list',
      description: 'List tenant/project scoped todos from the PostgreSQL planning ledger.',
      parameters: {
        type: 'object',
        properties: {
          tenantId: { type: 'string', description: 'Tenant scope, defaults to local' },
          projectId: { type: 'string', description: 'Project scope, defaults to los' },
          status: { type: 'string', enum: ['backlog', 'ready', 'in_progress', 'blocked', 'done', 'cancelled'] },
          kind: { type: 'string', enum: ['problem', 'solution', 'plan', 'phase', 'task', 'batch'] },
          limit: { type: 'number', description: 'Maximum rows, clamped by the service' },
          includeArchived: { type: 'boolean', description: 'Include archived todos' },
        },
        required: [],
      },
    },
  }, {
    riskLevel: 'L0',
    permissions: ['todo:read'],
    timeoutMs: 30_000,
    retryable: true,
    idempotent: true,
    costLevel: 'low',
    sideEffect: false,
    tags: ['todo', 'read'],
  });

  registry.register('todo_create', async (args) => {
    const title = normalizeToolString(args.title);
    if (!title) return { content: '', error: 'title is required' };
    const todo = await createTodo({
      title,
      description: normalizeToolString(args.description),
      tenantId: normalizeToolString(args.tenantId),
      projectId: normalizeToolString(args.projectId),
      userId: normalizeToolString(args.userId),
      nodeId: normalizeToolString(args.nodeId),
      stageId: normalizeToolString(args.stageId),
      parentId: normalizeToolString(args.parentId),
      kind: normalizeToolTodoKind(args.kind),
      status: normalizeToolTodoStatus(args.status),
      priority: normalizeToolTodoPriority(args.priority),
      source: normalizeToolString(args.source) ?? 'agent-tool',
      traceId: normalizeToolString(args.traceId),
      requestId: normalizeToolString(args.requestId),
      dedupeKey: normalizeToolString(args.dedupeKey),
      taskRunId: normalizeToolString(args.taskRunId),
      sessionId: normalizeToolString(args.sessionId),
      batchKey: normalizeToolString(args.batchKey),
      dependsOnIds: normalizeToolStringArray(args.dependsOnIds),
      metadata: normalizeToolObject(args.metadata),
    });
    return { content: JSON.stringify(todo, null, 2) };
  }, {
    type: 'function',
    function: {
      name: 'todo_create',
      description: 'Create a todo in the PostgreSQL planning ledger. Prefer providing tenantId, projectId, requestId, traceId, and dedupeKey.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          tenantId: { type: 'string' },
          projectId: { type: 'string' },
          userId: { type: 'string' },
          nodeId: { type: 'string' },
          stageId: { type: 'string' },
          parentId: { type: 'string' },
          kind: { type: 'string', enum: ['problem', 'solution', 'plan', 'phase', 'task', 'batch'] },
          status: { type: 'string', enum: ['backlog', 'ready', 'in_progress', 'blocked', 'done', 'cancelled'] },
          priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          source: { type: 'string' },
          traceId: { type: 'string' },
          requestId: { type: 'string' },
          dedupeKey: { type: 'string' },
          taskRunId: { type: 'string' },
          sessionId: { type: 'string' },
          batchKey: { type: 'string' },
          dependsOnIds: { type: 'array', items: { type: 'string' } },
          metadata: { type: 'object' },
        },
        required: ['title'],
      },
    },
  }, {
    riskLevel: 'L1',
    permissions: ['todo:write'],
    timeoutMs: 30_000,
    retryable: false,
    idempotent: false,
    costLevel: 'low',
    sideEffect: true,
    tags: ['todo', 'write'],
  });

  registry.register('todo_update', async (args) => {
    const id = normalizeToolString(args.id);
    if (!id) return { content: '', error: 'id is required' };
    const todo = await updateTodo(id, {
      title: normalizeToolString(args.title),
      description: normalizeToolString(args.description),
      kind: normalizeToolTodoKind(args.kind),
      status: normalizeToolTodoStatus(args.status),
      priority: normalizeToolTodoPriority(args.priority),
      userId: normalizeToolNullableString(args.userId),
      nodeId: normalizeToolNullableString(args.nodeId),
      stageId: normalizeToolNullableString(args.stageId),
      parentId: normalizeToolNullableString(args.parentId),
      traceId: normalizeToolNullableString(args.traceId),
      requestId: normalizeToolNullableString(args.requestId),
      dedupeKey: normalizeToolNullableString(args.dedupeKey),
      taskRunId: normalizeToolNullableString(args.taskRunId),
      sessionId: normalizeToolNullableString(args.sessionId),
      batchKey: normalizeToolNullableString(args.batchKey),
      dependsOnIds: args.dependsOnIds === undefined ? undefined : normalizeToolStringArray(args.dependsOnIds) ?? [],
      metadata: args.metadata === undefined ? undefined : normalizeToolObject(args.metadata),
    });
    if (!todo) return { content: '', error: `Todo not found: ${id}` };
    return { content: JSON.stringify(todo, null, 2) };
  }, {
    type: 'function',
    function: {
      name: 'todo_update',
      description: 'Update an existing todo status, fields, metadata, or dependencies.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          kind: { type: 'string', enum: ['problem', 'solution', 'plan', 'phase', 'task', 'batch'] },
          status: { type: 'string', enum: ['backlog', 'ready', 'in_progress', 'blocked', 'done', 'cancelled'] },
          priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          userId: { type: ['string', 'null'] },
          nodeId: { type: ['string', 'null'] },
          stageId: { type: ['string', 'null'] },
          parentId: { type: ['string', 'null'] },
          traceId: { type: ['string', 'null'] },
          requestId: { type: ['string', 'null'] },
          dedupeKey: { type: ['string', 'null'] },
          taskRunId: { type: ['string', 'null'] },
          sessionId: { type: ['string', 'null'] },
          batchKey: { type: ['string', 'null'] },
          dependsOnIds: { type: 'array', items: { type: 'string' } },
          metadata: { type: 'object' },
        },
        required: ['id'],
      },
    },
  }, {
    riskLevel: 'L1',
    permissions: ['todo:write'],
    timeoutMs: 30_000,
    retryable: false,
    idempotent: false,
    costLevel: 'low',
    sideEffect: true,
    tags: ['todo', 'write'],
  });

  registry.register('todo_archive', async (args) => {
    const id = normalizeToolString(args.id);
    if (!id) return { content: '', error: 'id is required' };
    const todo = await archiveTodo(id, normalizeToolString(args.reason));
    if (!todo) return { content: '', error: `Todo not found: ${id}` };
    return { content: JSON.stringify(todo, null, 2) };
  }, {
    type: 'function',
    function: {
      name: 'todo_archive',
      description: 'Archive a todo while preserving tenant/project/trace evidence.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['id'],
      },
    },
  }, {
    riskLevel: 'L1',
    permissions: ['todo:write'],
    timeoutMs: 30_000,
    retryable: false,
    idempotent: false,
    costLevel: 'low',
    sideEffect: true,
    tags: ['todo', 'write'],
  });

  registry.register('todo_reopen', async (args) => {
    const id = normalizeToolString(args.id);
    if (!id) return { content: '', error: 'id is required' };
    const todo = await reopenTodo(id);
    if (!todo) return { content: '', error: `Todo not found: ${id}` };
    return { content: JSON.stringify(todo, null, 2) };
  }, {
    type: 'function',
    function: {
      name: 'todo_reopen',
      description: 'Reopen a done/cancelled/archived todo to ready without dropping trace metadata.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
    },
  }, {
    riskLevel: 'L1',
    permissions: ['todo:write'],
    timeoutMs: 30_000,
    retryable: false,
    idempotent: false,
    costLevel: 'low',
    sideEffect: true,
    tags: ['todo', 'write'],
  });

  registry.register('todo_link_dependency', async (args) => {
    const id = normalizeToolString(args.id);
    const dependsOnId = normalizeToolString(args.dependsOnId);
    if (!id) return { content: '', error: 'id is required' };
    if (!dependsOnId) return { content: '', error: 'dependsOnId is required' };
    const existing = await loadTodo(id);
    if (!existing) return { content: '', error: `Todo not found: ${id}` };
    const todo = await updateTodo(id, {
      dependsOnIds: uniqueStrings([...existing.dependsOnIds, dependsOnId]),
    });
    return { content: JSON.stringify(todo, null, 2) };
  }, {
    type: 'function',
    function: {
      name: 'todo_link_dependency',
      description: 'Add a hard blocks dependency from one todo to another todo.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Todo that is blocked' },
          dependsOnId: { type: 'string', description: 'Todo that must complete first' },
        },
        required: ['id', 'dependsOnId'],
      },
    },
  }, {
    riskLevel: 'L1',
    permissions: ['todo:write'],
    timeoutMs: 30_000,
    retryable: false,
    idempotent: false,
    costLevel: 'low',
    sideEffect: true,
    tags: ['todo', 'write'],
  });
}

function normalizeToolString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeToolNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return normalizeToolString(value);
}

function normalizeToolStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const normalized = value.map(normalizeToolString).filter((item): item is string => Boolean(item));
    return normalized.length > 0 ? uniqueStrings(normalized) : undefined;
  }
  if (typeof value === 'string') {
    const normalized = value.split(',').map(normalizeToolString).filter((item): item is string => Boolean(item));
    return normalized.length > 0 ? uniqueStrings(normalized) : undefined;
  }
  return undefined;
}

function normalizeToolObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function normalizeToolNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.floor(value);
}

function normalizeToolTodoKind(value: unknown): TodoKind | undefined {
  if (value === 'problem' || value === 'solution' || value === 'plan' || value === 'phase' || value === 'task' || value === 'batch') return value;
  return undefined;
}

function normalizeToolTodoStatus(value: unknown): TodoStatus | undefined {
  if (value === 'backlog' || value === 'ready' || value === 'in_progress' || value === 'blocked' || value === 'done' || value === 'cancelled') return value;
  return undefined;
}

function normalizeToolTodoPriority(value: unknown): TodoPriority | undefined {
  if (value === 'P0' || value === 'P1' || value === 'P2' || value === 'P3') return value;
  return undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}
