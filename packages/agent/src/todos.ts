/**
 * @los/agent/todos - Tenant/project scoped planning ledger.
 *
 * Todos sit above scheduled task runs. They record problems, decisions, phases,
 * and dispatchable work before an agent task is created.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
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

import {
  appendOptionalClause,
  assertRow,
  normalizeJsonObject,
  normalizeOptionalString,
  normalizeRequiredString,
  normalizeStringArray,
  normalizeTodoKind,
  normalizeTodoPriority,
  normalizeTodoStatus,
  pickNullable,
} from './todos/normalizers.js';
import { rowToTodo } from './todos/rows.js';
import { loadTodoRelations, replaceTodoDependencies, loadTodoDomino } from './todos/relations.js';

export { loadTodoDomino };

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
  const rows = await db.query<import('./todos/rows.js').TodoRow>('SELECT * FROM todos WHERE id = $1', [id]);
  if (!rows.rows[0]) return null;
  const relationMap = await loadTodoRelations([id]);
  return rowToTodo(rows.rows[0] as any, relationMap.get(id));
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
  const rows = await db.query<import('./todos/rows.js').TodoRow>(
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
  /** If set, also load todo seeds from <workspaceRoot>/.los/todos/seed.json. */
  workspaceRoot?: string;
  /** Override the default projectId for seeded todos (default: 'los'). */
  projectId?: string;
}

export async function seedLosPlanningTodos(options: SeedLosPlanningTodosOptions = {}): Promise<TodoRecord[]> {
  await ensureTodoStore();
  const out: TodoRecord[] = [];

  // Build the seed list: built-in seeds first, then external seeds from workspace.
  // External seeds are tagged with the requested projectId; the built-in los
  // seeds keep their own projectId so cross-project seeding doesn't relabel
  // los-internal planning todos.
  const seedItems: CreateTodoInput[] = [...LOS_PLANNING_TODO_SEED];
  if (options.workspaceRoot) {
    const externalPath = resolve(options.workspaceRoot, '.los', 'todos', 'seed.json');
    try {
      if (existsSync(externalPath)) {
        const raw = readFileSync(externalPath, 'utf-8');
        const external = JSON.parse(raw) as CreateTodoInput[];
        const projectId = options.projectId ?? 'los';
        for (const item of external) {
          seedItems.push({ ...item, projectId: item.projectId ?? projectId });
        }
      }
    } catch {
      // External seed file missing or unreadable — use only built-in seeds
    }
  }

  const seedIds = seedItems.map(item => item.id).filter((id): id is string => Boolean(id));
  const existingIds = new Set<string>();
  if (seedIds.length > 0) {
    const db = getDb();
    const existing = await db.query<{ id: string }>(
      `SELECT id FROM todos WHERE id = ANY($1::text[])`,
      [seedIds],
    );
    for (const row of existing.rows) existingIds.add(row.id);
  }

  for (const item of seedItems) {
    if (item.id && !options.overwrite && existingIds.has(item.id)) {
      const existing = await loadTodo(item.id);
      if (existing) { out.push(existing); continue; }
    }
    out.push(await createTodo(item));
  }
  return out;
}

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
