import test from 'node:test';
import assert from 'node:assert/strict';

import { LOS_PLANNING_TODO_SEED } from './todo-seeds.js';

const RESOLVED_P0_IDS = [
  'todo-los-p0-file-size-gate',
  'todo-los-p0-db-schema-ddl',
  'todo-los-p0-unwired-exports-ci',
  'todo-los-p0-memory-production',
  'todo-los-p0-governance-sweeper',
  'todo-los-p0-eval-probes',
  'todo-los-p0-ap6-child-contract',
  'todo-los-p0-mcp-connection-leak',
  'todo-los-p0-schema-consistency',
  'todo-los-p0-check-secrets',
  'todo-los-transport-sse-ws-recovery',
] as const;

test('resolved P0 seeds do not regress to active states', () => {
  const resolved = new Map(LOS_PLANNING_TODO_SEED.map(todo => [todo.id, todo]));

  for (const id of RESOLVED_P0_IDS) {
    assert.equal(resolved.get(id)?.status, 'done', id);
  }
});

test('resolved P0 seeds retain completion evidence', () => {
  const resolved = new Map(LOS_PLANNING_TODO_SEED.map(todo => [todo.id, todo]));

  for (const id of RESOLVED_P0_IDS) {
    const todo = resolved.get(id);
    assert.ok(todo, `${id} is missing`);
    assert.ok(Array.isArray(todo.metadata?.evidence), `${todo.id} is missing evidence`);
    assert.ok((todo.metadata?.evidence as unknown[]).length > 0, `${todo.id} has empty evidence`);
  }
});
