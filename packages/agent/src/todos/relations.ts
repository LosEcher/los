import { getDb } from '@los/infra/db';
import { uniqueStrings } from './normalizers.js';
import { rowToTodo, type TodoRow } from './rows.js';
import type { TodoRecord } from '../todo-types.js';

type TodoRelationMap = Map<string, { dependsOnIds: string[]; blockedByIds: string[] }>;

export async function loadTodoRelations(todoIds: string[]): Promise<TodoRelationMap> {
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

export async function replaceTodoDependencies(
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

export async function loadTodoDomino(id: string): Promise<TodoRecord[]> {
  const db = getDb();
  const allRows: TodoRow[] = [];
  const seen = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (seen.has(currentId) || seen.size > 2000) continue;
    seen.add(currentId);
    const result = await db.query<TodoRow>('SELECT * FROM todos WHERE id = $1', [currentId]);
    const row = result.rows[0];
    if (!row) continue;
    allRows.push(row);
    const depResult = await db.query<{ depends_on_todo_id: string; blocked_todo_id: string }>(
      `
      SELECT depends_on_todo_id, NULL AS blocked_todo_id FROM todo_dependencies WHERE todo_id = $1
      UNION
      SELECT NULL AS depends_on_todo_id, todo_id AS blocked_todo_id FROM todo_dependencies WHERE depends_on_todo_id = $1
    `,
      [currentId],
    );
    for (const dep of depResult.rows) {
      if (dep.depends_on_todo_id) queue.push(dep.depends_on_todo_id);
      if (dep.blocked_todo_id) queue.push(dep.blocked_todo_id);
    }
  }
  if (allRows.length === 0) return [];
  const relationMap = await loadTodoRelations(allRows.map(r => r.id));
  return allRows.map(row => rowToTodo(row, relationMap.get(row.id)));
}
