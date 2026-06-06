/**
 * @los/agent/todos - Tenant/project scoped planning ledger.
 *
 * Todos sit above scheduled task runs. They record problems, decisions, phases,
 * and dispatchable work before an agent task is created.
 */

import { randomUUID } from 'node:crypto';
import { getDb, withDbClient } from '@los/infra/db';
import { TODO_SCHEMA } from './todo-schema.js';
import { LOS_PLANNING_TODO_SEED } from './todo-seeds.js';
import { mergeRunContractMetadata } from './run-contract.js';
import type {
  CreateTodoInput,
  ListTodosOptions,
  TodoKind,
  TodoPriority,
  TodoRecord,
  TodoStatus,
  UpdateTodoInput,
} from './todo-types.js';

export type {
  CreateTodoInput,
  ListTodosOptions,
  TodoKind,
  TodoPriority,
  TodoRecord,
  TodoStatus,
  UpdateTodoInput,
} from './todo-types.js';

let _initialized = false;

export async function ensureTodoStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(TODO_SCHEMA);
  _initialized = true;
}

export async function createTodo(input: CreateTodoInput): Promise<TodoRecord> {
  await ensureTodoStore();
  const normalized = normalizeCreateInput(input);
  await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(
        `
        INSERT INTO todos (
          id, tenant_id, project_id, user_id, node_id, stage_id, parent_id,
          title, description, kind, status, priority, source,
          trace_id, request_id, dedupe_key, task_run_id, session_id, batch_key,
          metadata_json
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13,
          $14, $15, $16, $17, $18, $19,
          $20::jsonb
        )
        ON CONFLICT (id) DO UPDATE SET
          tenant_id = EXCLUDED.tenant_id,
          project_id = EXCLUDED.project_id,
          user_id = EXCLUDED.user_id,
          node_id = EXCLUDED.node_id,
          stage_id = EXCLUDED.stage_id,
          parent_id = EXCLUDED.parent_id,
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          kind = EXCLUDED.kind,
          status = EXCLUDED.status,
          priority = EXCLUDED.priority,
          source = EXCLUDED.source,
          trace_id = EXCLUDED.trace_id,
          request_id = EXCLUDED.request_id,
          dedupe_key = EXCLUDED.dedupe_key,
          task_run_id = EXCLUDED.task_run_id,
          session_id = EXCLUDED.session_id,
          batch_key = EXCLUDED.batch_key,
          metadata_json = EXCLUDED.metadata_json,
          updated_at = now()
      `,
        [
          normalized.id,
          normalized.tenantId,
          normalized.projectId,
          normalized.userId ?? null,
          normalized.nodeId ?? null,
          normalized.stageId ?? null,
          normalized.parentId ?? null,
          normalized.title,
          normalized.description,
          normalized.kind,
          normalized.status,
          normalized.priority,
          normalized.source,
          normalized.traceId ?? null,
          normalized.requestId ?? null,
          normalized.dedupeKey ?? null,
          normalized.taskRunId ?? null,
          normalized.sessionId ?? null,
          normalized.batchKey ?? null,
          JSON.stringify(normalized.metadata),
        ],
      );
      if (normalized.dependsOnIds !== undefined) {
        await replaceTodoDependencies(client, normalized.id, normalized.dependsOnIds);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  return assertRow(await loadTodo(normalized.id));
}

export async function updateTodo(id: string, input: UpdateTodoInput): Promise<TodoRecord | null> {
  await ensureTodoStore();
  const existing = await loadTodo(id);
  if (!existing) return null;

  const nextStatus = normalizeTodoStatus(input.status, existing.status);
  const metadata = input.runContract === undefined
    ? input.metadata ?? existing.metadata
    : mergeRunContractMetadata(input.metadata ?? existing.metadata, input.runContract);
  await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(
        `
        UPDATE todos
        SET title = $2,
            description = $3,
            kind = $4,
            status = $5,
            priority = $6,
            user_id = $7,
            node_id = $8,
            stage_id = $9,
            parent_id = $10,
            trace_id = $11,
            request_id = $12,
            dedupe_key = $13,
            task_run_id = $14,
            session_id = $15,
            batch_key = $16,
            metadata_json = $17::jsonb,
            updated_at = now(),
            started_at = CASE WHEN $5 = 'in_progress' AND started_at IS NULL THEN now() ELSE started_at END,
            completed_at = CASE WHEN $5 = 'done' THEN now() WHEN $5 <> 'done' THEN NULL ELSE completed_at END,
            cancelled_at = CASE WHEN $5 = 'cancelled' THEN now() WHEN $5 <> 'cancelled' THEN NULL ELSE cancelled_at END,
            reopened_at = CASE WHEN $5 IN ('backlog', 'ready') AND status IN ('done', 'cancelled') THEN now() ELSE reopened_at END
        WHERE id = $1
      `,
        [
          id,
          input.title ?? existing.title,
          input.description ?? existing.description,
          normalizeTodoKind(input.kind, existing.kind),
          nextStatus,
          normalizeTodoPriority(input.priority, existing.priority),
          pickNullable(input.userId, existing.userId),
          pickNullable(input.nodeId, existing.nodeId),
          pickNullable(input.stageId, existing.stageId),
          pickNullable(input.parentId, existing.parentId),
          pickNullable(input.traceId, existing.traceId),
          pickNullable(input.requestId, existing.requestId),
          pickNullable(input.dedupeKey, existing.dedupeKey),
          pickNullable(input.taskRunId, existing.taskRunId),
          pickNullable(input.sessionId, existing.sessionId),
          pickNullable(input.batchKey, existing.batchKey),
          JSON.stringify(metadata),
        ],
      );
      if (input.dependsOnIds !== undefined) {
        await replaceTodoDependencies(client, id, input.dependsOnIds ?? []);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  return await loadTodo(id);
}

export async function archiveTodo(id: string, reason?: string): Promise<TodoRecord | null> {
  await ensureTodoStore();
  await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(
        `
        UPDATE todos
        SET archived_at = now(),
            archive_reason = $2,
            updated_at = now()
        WHERE id = $1
      `,
        [id, normalizeOptionalString(reason) ?? 'archived_from_todo'],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  return await loadTodo(id);
}

export async function unarchiveTodo(id: string): Promise<TodoRecord | null> {
  await ensureTodoStore();
  await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(
        `
        UPDATE todos
        SET archived_at = NULL,
            archive_reason = NULL,
            updated_at = now()
        WHERE id = $1
      `,
        [id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  return await loadTodo(id);
}

export async function reopenTodo(id: string): Promise<TodoRecord | null> {
  await ensureTodoStore();
  const existing = await loadTodo(id);
  if (!existing) return null;
  await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(
        `
        UPDATE todos
        SET status = 'ready',
            archived_at = NULL,
            archive_reason = NULL,
            completed_at = NULL, cancelled_at = NULL,
            updated_at = now(),
            reopened_at = CASE WHEN status IN ('done', 'cancelled') THEN now() ELSE reopened_at END
        WHERE id = $1
      `,
        [id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  return await loadTodo(id);
}

export async function loadTodo(id: string): Promise<TodoRecord | null> {
  await ensureTodoStore();
  const db = getDb();
  const rows = await db.query<TodoRow>('SELECT * FROM todos WHERE id = $1', [id]);
  if (!rows.rows[0]) return null;
  const relationMap = await loadTodoRelations([id]);
  return rowToTodo(rows.rows[0], relationMap.get(id));
}

export async function listTodos(options: ListTodosOptions = {}): Promise<TodoRecord[]> {
  await ensureTodoStore();
  const tenantId = normalizeOptionalString(options.tenantId) ?? 'local';
  const projectId = normalizeOptionalString(options.projectId) ?? 'los';
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
  const params: unknown[] = [tenantId, projectId];
  const clauses = ['tenant_id = $1', 'project_id = $2'];

  if (options.status) {
    params.push(normalizeTodoStatus(options.status));
    clauses.push(`status = $${params.length}`);
  }
  if (options.kind) {
    params.push(normalizeTodoKind(options.kind));
    clauses.push(`kind = $${params.length}`);
  }
  appendOptionalClause(clauses, params, 'stage_id', options.stageId);
  appendOptionalClause(clauses, params, 'source', options.source);
  appendOptionalClause(clauses, params, 'trace_id', options.traceId);
  appendOptionalClause(clauses, params, 'request_id', options.requestId);
  appendOptionalClause(clauses, params, 'task_run_id', options.taskRunId);
  appendOptionalClause(clauses, params, 'session_id', options.sessionId);
  appendOptionalClause(clauses, params, 'batch_key', options.batchKey);
  if (!options.includeArchived) {
    clauses.push('archived_at IS NULL');
  }

  params.push(limit);
  const db = getDb();
  const rows = await db.query<TodoRow>(
    `
    SELECT *
    FROM todos
    WHERE ${clauses.join(' AND ')}
    ORDER BY
      CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END,
      CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
      updated_at DESC
    LIMIT $${params.length}
  `,
    params,
  );
  const relationMap = await loadTodoRelations(rows.rows.map((row) => row.id));
  return rows.rows.map((row) => rowToTodo(row, relationMap.get(row.id)));
}

export interface SeedLosPlanningTodosOptions {
  overwrite?: boolean;
}

export async function seedLosPlanningTodos(options: SeedLosPlanningTodosOptions = {}): Promise<TodoRecord[]> {
  await ensureTodoStore();
  const out: TodoRecord[] = [];
  for (const item of LOS_PLANNING_TODO_SEED) {
    if (!options.overwrite && item.id) {
      const existing = await loadTodo(item.id);
      if (existing) {
        out.push(existing);
        continue;
      }
    }
    out.push(await createTodo(item));
  }
  return out;
}

type TodoRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  user_id: string | null;
  node_id: string | null;
  stage_id: string | null;
  parent_id: string | null;
  title: string;
  description: string;
  kind: TodoKind;
  status: TodoStatus;
  priority: TodoPriority;
  source: string;
  trace_id: string | null;
  request_id: string | null;
  dedupe_key: string | null;
  task_run_id: string | null;
  session_id: string | null;
  batch_key: string | null;
  archived_at: Date | string | null;
  archive_reason: string | null;
  metadata_json: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  cancelled_at: Date | string | null;
  reopened_at: Date | string | null;
};

type TodoRelationMap = Map<string, { dependsOnIds: string[]; blockedByIds: string[] }>;

function normalizeCreateInput(input: CreateTodoInput): Required<Pick<CreateTodoInput, 'id' | 'tenantId' | 'projectId' | 'title' | 'description' | 'kind' | 'status' | 'priority' | 'source' | 'metadata'>> & CreateTodoInput {
  return {
    ...input,
    id: normalizeOptionalString(input.id) ?? `todo-${randomUUID()}`,
    tenantId: normalizeOptionalString(input.tenantId) ?? 'local',
    projectId: normalizeOptionalString(input.projectId) ?? 'los',
    title: normalizeRequiredString(input.title, 'title'),
    description: normalizeOptionalString(input.description) ?? '',
    kind: normalizeTodoKind(input.kind),
    status: normalizeTodoStatus(input.status),
    priority: normalizeTodoPriority(input.priority),
    source: normalizeOptionalString(input.source) ?? 'manual',
    dependsOnIds: input.dependsOnIds ? normalizeStringArray(input.dependsOnIds) ?? [] : input.dependsOnIds,
    metadata: mergeRunContractMetadata(input.metadata, input.runContract),
  };
}

function rowToTodo(row: TodoRow, relations?: { dependsOnIds?: string[]; blockedByIds?: string[] }): TodoRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    userId: row.user_id ?? undefined,
    nodeId: row.node_id ?? undefined,
    stageId: row.stage_id ?? undefined,
    parentId: row.parent_id ?? undefined,
    title: row.title,
    description: row.description,
    kind: row.kind,
    status: row.status,
    priority: row.priority,
    source: row.source,
    traceId: row.trace_id ?? undefined,
    requestId: row.request_id ?? undefined,
    dedupeKey: row.dedupe_key ?? undefined,
    taskRunId: row.task_run_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    batchKey: row.batch_key ?? undefined,
    dependsOnIds: relations?.dependsOnIds ?? [],
    blockedByIds: relations?.blockedByIds ?? [],
    archivedAt: row.archived_at ? toIsoString(row.archived_at) : undefined,
    archiveReason: row.archive_reason ?? undefined,
    metadata: normalizeJsonObject(row.metadata_json),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    startedAt: row.started_at ? toIsoString(row.started_at) : undefined,
    completedAt: row.completed_at ? toIsoString(row.completed_at) : undefined,
    cancelledAt: row.cancelled_at ? toIsoString(row.cancelled_at) : undefined,
    reopenedAt: row.reopened_at ? toIsoString(row.reopened_at) : undefined,
  };
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

function pickNullable(value: string | null | undefined, fallback: string | undefined): string | null {
  if (value === null) return null;
  return normalizeOptionalString(value) ?? fallback ?? null;
}

function normalizeRequiredString(value: unknown, name: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function appendOptionalClause(
  clauses: string[],
  params: unknown[],
  column: string,
  value: unknown,
): void {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return;
  params.push(normalized);
  clauses.push(`${column} = $${params.length}`);
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const normalized = value.map((item) => normalizeOptionalString(item)).filter((item): item is string => Boolean(item));
    return normalized.length > 0 ? uniqueStrings(normalized) : undefined;
  }
  if (typeof value === 'string') {
    const normalized = value.split(',').map((item) => normalizeOptionalString(item)).filter((item): item is string => Boolean(item));
    return normalized.length > 0 ? uniqueStrings(normalized) : undefined;
  }
  return undefined;
}

async function replaceTodoDependencies(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  todoId: string,
  dependsOnIds: string[],
): Promise<void> {
  await client.query('DELETE FROM todo_dependencies WHERE todo_id = $1', [todoId]);
  for (const dependsOnId of uniqueStrings(dependsOnIds)) {
    if (dependsOnId === todoId) continue;
    await client.query(
      `
      INSERT INTO todo_dependencies (todo_id, depends_on_todo_id, relation_type)
      VALUES ($1, $2, 'blocks')
      ON CONFLICT DO NOTHING
    `,
      [todoId, dependsOnId],
    );
  }
}

async function loadTodoRelations(todoIds: string[]): Promise<TodoRelationMap> {
  const ids = uniqueStrings(todoIds);
  const relationMap: TodoRelationMap = new Map();
  if (ids.length === 0) return relationMap;

  const db = getDb();
  const rows = await db.query<{
    todo_id: string;
    depends_on_todo_id: string;
    relation_type: string;
  }>(
    `
    SELECT todo_id, depends_on_todo_id, relation_type
    FROM todo_dependencies
    WHERE todo_id = ANY($1::text[])
       OR depends_on_todo_id = ANY($1::text[])
  `,
    [ids],
  );

  for (const row of rows.rows) {
    if (row.relation_type !== 'blocks') continue;
    const dependents = relationMap.get(row.todo_id) ?? { dependsOnIds: [], blockedByIds: [] };
    dependents.dependsOnIds.push(row.depends_on_todo_id);
    relationMap.set(row.todo_id, dependents);

    const upstream = relationMap.get(row.depends_on_todo_id) ?? { dependsOnIds: [], blockedByIds: [] };
    upstream.blockedByIds.push(row.todo_id);
    relationMap.set(row.depends_on_todo_id, upstream);
  }

  for (const value of relationMap.values()) {
    value.dependsOnIds = uniqueStrings(value.dependsOnIds);
    value.blockedByIds = uniqueStrings(value.blockedByIds);
  }
  return relationMap;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeOptionalString(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertRow<T>(row: T | null | undefined): T {
  if (!row) throw new Error('Failed to write todo');
  return row;
}
