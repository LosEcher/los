import { getDb, withInitDb } from '@los/infra/db';
import { LOS_PLANNING_TODO_SEED } from './todo-seeds.js';
import type { CreateTodoInput, TodoKind, TodoPriority, TodoStatus } from './todo-types.js';

export interface GovernanceTodoSnapshot {
  id: string;
  title: string;
  status: TodoStatus;
  kind: TodoKind;
  priority: TodoPriority;
  source: string;
  archivedAt?: string;
}

export interface TodoReconciliationOptions {
  tenantId?: string;
  projectId?: string;
  includeArchived?: boolean;
}

export interface TodoReconciliationItem {
  id: string;
  title: string;
  status?: TodoStatus;
  expectedStatus?: TodoStatus;
  actualStatus?: TodoStatus;
  archivedAt?: string;
}

export interface TodoStatusDrift {
  id: string;
  title: string;
  expectedStatus: TodoStatus;
  actualStatus: TodoStatus;
  archivedAt?: string;
}

export interface TodoReconciliationReport {
  tenantId: string;
  projectId: string;
  includeArchived: boolean;
  seedCount: number;
  dbCount: number;
  activeCounts: Record<TodoStatus, number>;
  seedOnly: TodoReconciliationItem[];
  dbOnly: TodoReconciliationItem[];
  statusDrift: TodoStatusDrift[];
}

type TodoDbRow = {
  id: string;
  title: string;
  status: TodoStatus;
  kind: TodoKind;
  priority: TodoPriority;
  source: string;
  archived_at: Date | string | null;
};

const TODO_STATUSES: TodoStatus[] = ['backlog', 'ready', 'in_progress', 'blocked', 'done', 'cancelled'];

export async function reconcilePlanningTodosWithDefaultDb(
  options: TodoReconciliationOptions = {},
): Promise<TodoReconciliationReport> {
  return withInitDb(() => reconcilePlanningTodosFromOpenDb(options));
}

export async function reconcilePlanningTodosFromOpenDb(
  options: TodoReconciliationOptions = {},
): Promise<TodoReconciliationReport> {
  const tenantId = normalizeOptionalString(options.tenantId) ?? 'local';
  const projectId = normalizeOptionalString(options.projectId) ?? 'los';
  const includeArchived = options.includeArchived === true;
  const db = getDb();
  const rows = await db.query<TodoDbRow>(
    `
    SELECT id, title, status, kind, priority, source, archived_at
    FROM todos
    WHERE tenant_id = $1
      AND project_id = $2
      AND ($3::boolean OR archived_at IS NULL)
    ORDER BY
      CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
      updated_at DESC
  `,
    [tenantId, projectId, includeArchived],
  );

  return reconcilePlanningTodos({
    seeds: LOS_PLANNING_TODO_SEED,
    dbTodos: rows.rows.map(rowToSnapshot),
    tenantId,
    projectId,
    includeArchived,
  });
}

export function reconcilePlanningTodos(input: {
  seeds: CreateTodoInput[];
  dbTodos: GovernanceTodoSnapshot[];
  tenantId?: string;
  projectId?: string;
  includeArchived?: boolean;
}): TodoReconciliationReport {
  const tenantId = normalizeOptionalString(input.tenantId) ?? 'local';
  const projectId = normalizeOptionalString(input.projectId) ?? 'los';
  const seeds = input.seeds
    .map(normalizeSeedTodo)
    .filter((todo): todo is GovernanceTodoSnapshot => todo !== null);
  const seedById = new Map(seeds.map(todo => [todo.id, todo]));
  const dbById = new Map(input.dbTodos.map(todo => [todo.id, todo]));

  const seedOnly: TodoReconciliationItem[] = [];
  const dbOnly: TodoReconciliationItem[] = [];
  const statusDrift: TodoStatusDrift[] = [];

  for (const seed of seeds) {
    const dbTodo = dbById.get(seed.id);
    if (!dbTodo) {
      seedOnly.push({
        id: seed.id,
        title: seed.title,
        expectedStatus: seed.status,
      });
      continue;
    }
    if (dbTodo.status !== seed.status) {
      statusDrift.push({
        id: seed.id,
        title: dbTodo.title || seed.title,
        expectedStatus: seed.status,
        actualStatus: dbTodo.status,
        archivedAt: dbTodo.archivedAt,
      });
    }
  }

  for (const todo of input.dbTodos) {
    if (!seedById.has(todo.id)) {
      dbOnly.push({
        id: todo.id,
        title: todo.title,
        status: todo.status,
        archivedAt: todo.archivedAt,
      });
    }
  }

  return {
    tenantId,
    projectId,
    includeArchived: input.includeArchived === true,
    seedCount: seeds.length,
    dbCount: input.dbTodos.length,
    activeCounts: countStatuses(input.dbTodos.filter(todo => !todo.archivedAt)),
    seedOnly: sortItems(seedOnly),
    dbOnly: sortItems(dbOnly),
    statusDrift: statusDrift.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function normalizeSeedTodo(input: CreateTodoInput): GovernanceTodoSnapshot | null {
  const id = normalizeOptionalString(input.id);
  if (!id) return null;
  return {
    id,
    title: normalizeOptionalString(input.title) ?? id,
    status: normalizeTodoStatus(input.status),
    kind: normalizeTodoKind(input.kind),
    priority: normalizeTodoPriority(input.priority),
    source: normalizeOptionalString(input.source) ?? 'manual',
  };
}

function rowToSnapshot(row: TodoDbRow): GovernanceTodoSnapshot {
  return {
    id: row.id,
    title: row.title,
    status: normalizeTodoStatus(row.status),
    kind: normalizeTodoKind(row.kind),
    priority: normalizeTodoPriority(row.priority),
    source: row.source,
    archivedAt: row.archived_at ? toIsoString(row.archived_at) : undefined,
  };
}

function countStatuses(todos: GovernanceTodoSnapshot[]): Record<TodoStatus, number> {
  const counts = Object.fromEntries(TODO_STATUSES.map(status => [status, 0])) as Record<TodoStatus, number>;
  for (const todo of todos) counts[todo.status] += 1;
  return counts;
}

function sortItems<T extends { id: string }>(items: T[]): T[] {
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeTodoKind(value: unknown, fallback: TodoKind = 'task'): TodoKind {
  if (value === 'problem' || value === 'solution' || value === 'plan' || value === 'phase' || value === 'task' || value === 'batch') return value;
  return fallback;
}

function normalizeTodoStatus(value: unknown, fallback: TodoStatus = 'backlog'): TodoStatus {
  if (value === 'backlog' || value === 'ready' || value === 'in_progress' || value === 'blocked' || value === 'done' || value === 'cancelled') return value;
  return fallback;
}

function normalizeTodoPriority(value: unknown, fallback: TodoPriority = 'P2'): TodoPriority {
  if (value === 'P0' || value === 'P1' || value === 'P2' || value === 'P3') return value;
  return fallback;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
