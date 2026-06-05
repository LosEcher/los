import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { createTodo, loadTodo, updateTodo } from './todos.js';

test('todos persist run contract metadata without dropping existing metadata', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const id = `todo-run-contract-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    const created = await createTodo({
      id,
      title: 'run contract metadata test',
      metadata: { project: 'los' },
      runContract: {
        mode: 'execution',
        goal: 'persist todo contract',
        editableSurfaces: ['packages/agent/src/todos.ts'],
        requiredChecks: ['pnpm --filter @los/agent test'],
        stopConditions: ['auth mutation'],
        evidenceRequired: ['loaded todo row'],
        commitBoundary: 'test-only',
      },
    });

    assert.equal(created.metadata.project, 'los');
    assert.deepEqual(created.metadata.runContract, {
      mode: 'execution',
      goal: 'persist todo contract',
      editableSurfaces: ['packages/agent/src/todos.ts'],
      requiredChecks: ['pnpm --filter @los/agent test'],
      allowedSkippedChecks: [],
      stopConditions: ['auth mutation'],
      evidenceRequired: ['loaded todo row'],
      commitBoundary: 'test-only',
      externalEvidenceAllowed: [],
      rawEvidenceProhibited: [],
    });

    const updated = await updateTodo(id, {
      metadata: { project: 'los', phase: 'update' },
      runContract: {
        mode: 'closeout',
        requiredChecks: ['pnpm check'],
      },
    });
    assert.equal(updated?.metadata.phase, 'update');
    assert.deepEqual(updated?.metadata.runContract, {
      mode: 'closeout',
      editableSurfaces: [],
      requiredChecks: ['pnpm check'],
      allowedSkippedChecks: [],
      stopConditions: [],
      evidenceRequired: [],
      externalEvidenceAllowed: [],
      rawEvidenceProhibited: [],
    });

    const loaded = await loadTodo(id);
    assert.equal(loaded?.metadata.project, 'los');
    assert.equal((loaded?.metadata.runContract as Record<string, unknown> | undefined)?.mode, 'closeout');
  } finally {
    await getDb().query('DELETE FROM todo_dependencies WHERE todo_id = $1 OR depends_on_todo_id = $1', [id]).catch(() => undefined);
    await getDb().query('DELETE FROM todos WHERE id = $1', [id]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
