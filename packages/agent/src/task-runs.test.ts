import test from 'node:test';
import assert from 'node:assert/strict';

import { closeDb, initDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import {
  createTaskRun,
  ensureTaskRunStore,
  findActiveTaskRunByDedupeKey,
  loadTaskRun,
  listTaskRuns,
  updateTaskRun,
} from './task-runs.js';

test('task run lifecycle persists status changes', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  try {
    await ensureTaskRunStore();
    const id = `task-${Date.now()}`;
    const created = await createTaskRun({
      id,
      sessionId: 'session-1',
      traceId: `trace-${id}`,
      dedupeKey: `dedupe-${id}`,
      workspaceRoot: '/tmp/workspace',
      toolMode: 'project-write',
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      promptPreview: 'inspect repo',
      metadata: { project: 'los' },
    });
    assert.equal(created.status, 'queued');
    assert.equal(created.traceId, `trace-${id}`);
    assert.equal(created.dedupeKey, `dedupe-${id}`);
    assert.equal(created.toolMode, 'project-write');
    assert.equal(created.provider, 'deepseek');
    assert.equal(created.model, 'deepseek-reasoner');

    const duplicate = await findActiveTaskRunByDedupeKey(`dedupe-${id}`);
    assert.equal(duplicate?.id, id);

    const running = await updateTaskRun(id, { status: 'running', metadata: { stage: 'execute' } });
    assert.equal(running?.status, 'running');
    assert.equal(running?.metadata.stage, 'execute');
    assert.ok(running?.startedAt);

    const loaded = await loadTaskRun(id);
    assert.equal(loaded?.status, 'running');

    const tasks = await listTaskRuns(10);
    assert.ok(tasks.some(task => task.id === id));

    const succeeded = await updateTaskRun(id, { status: 'succeeded', metadata: { stage: 'done' } });
    assert.equal(succeeded?.status, 'succeeded');
    assert.ok(succeeded?.completedAt);

    const noActiveDuplicate = await findActiveTaskRunByDedupeKey(`dedupe-${id}`);
    assert.equal(noActiveDuplicate, null);
  } finally {
    await closeDb().catch(() => undefined);
  }
});
