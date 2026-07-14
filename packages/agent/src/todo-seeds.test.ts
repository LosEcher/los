import test from 'node:test';
import assert from 'node:assert/strict';

import { LOS_PLANNING_TODO_SEED } from './todo-seeds.js';

test('built-in todo ledger has no unresolved P0 seed', () => {
  const unresolved = LOS_PLANNING_TODO_SEED.filter(todo =>
    todo.priority === 'P0' && todo.status !== 'done' && todo.status !== 'cancelled');

  assert.deepEqual(
    unresolved.map(todo => ({ id: todo.id, status: todo.status })),
    [],
  );
});

test('resolved audit P0 seeds retain completion evidence', () => {
  const auditP0 = LOS_PLANNING_TODO_SEED.filter(todo =>
    todo.priority === 'P0' && todo.source?.startsWith('audit-'));

  assert.ok(auditP0.length > 0);
  for (const todo of auditP0) {
    assert.equal(todo.status, 'done', todo.id);
    assert.ok(Array.isArray(todo.metadata?.evidence), `${todo.id} is missing evidence`);
    assert.ok((todo.metadata?.evidence as unknown[]).length > 0, `${todo.id} has empty evidence`);
  }
});
