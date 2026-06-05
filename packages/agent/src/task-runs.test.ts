import test from 'node:test';
import assert from 'node:assert/strict';

import { closeDb, initDb, withDbClient } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import {
  createTaskRun,
  ensureTaskRunStore,
  findActiveTaskRunByDedupeKey,
  heartbeatTaskRun,
  loadTaskRun,
  listTaskRuns,
  recoverExpiredTaskRuns,
  recoverExpiredTaskRunsWithAdvisoryLock,
  TASK_RUN_STARTUP_RECOVERY_LOCK_KEY,
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
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-1',
      nodeId: 'node-1',
      requestId: `req-${id}`,
      workspaceRoot: '/tmp/workspace',
      toolMode: 'project-write',
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      promptPreview: 'inspect repo',
      metadata: { project: 'los' },
      runContract: {
        mode: 'execution',
        requiredChecks: ['pnpm --filter @los/agent test'],
        evidenceRequired: ['task_runs row'],
      },
    });
    assert.equal(created.status, 'queued');
    assert.equal(created.traceId, `trace-${id}`);
    assert.equal(created.dedupeKey, `dedupe-${id}`);
    assert.equal(created.tenantId, 'tenant-1');
    assert.equal(created.projectId, 'project-1');
    assert.equal(created.userId, 'user-1');
    assert.equal(created.nodeId, 'node-1');
    assert.equal(created.requestId, `req-${id}`);
    assert.equal(created.toolMode, 'project-write');
    assert.equal(created.provider, 'deepseek');
    assert.equal(created.model, 'deepseek-reasoner');
    assert.deepEqual(created.metadata.runContract, {
      mode: 'execution',
      editableSurfaces: [],
      requiredChecks: ['pnpm --filter @los/agent test'],
      allowedSkippedChecks: [],
      stopConditions: [],
      evidenceRequired: ['task_runs row'],
      externalEvidenceAllowed: [],
      rawEvidenceProhibited: [],
    });

    const duplicate = await findActiveTaskRunByDedupeKey(`dedupe-${id}`);
    assert.equal(duplicate?.id, id);

    const running = await updateTaskRun(id, {
      status: 'running',
      nodeId: 'node-2',
      leaseExpiresAt: new Date(Date.now() + 30_000),
      heartbeatAt: new Date(),
      metadata: { stage: 'execute' },
      runContract: {
        mode: 'closeout',
        requiredChecks: ['pnpm check'],
      },
    });
    assert.equal(running?.status, 'running');
    assert.equal(running?.nodeId, 'node-2');
    assert.equal(running?.metadata.stage, 'execute');
    assert.equal((running?.metadata.runContract as Record<string, unknown> | undefined)?.mode, 'closeout');
    assert.ok(running?.startedAt);
    assert.ok(running?.heartbeatAt);
    assert.ok(running?.leaseExpiresAt);

    const heartbeat = await heartbeatTaskRun(id, { nodeId: 'node-2', leaseMs: 30_000 });
    assert.equal(heartbeat?.nodeId, 'node-2');
    assert.ok(heartbeat?.heartbeatAt);

    const loaded = await loadTaskRun(id);
    assert.equal(loaded?.status, 'running');

    const tasks = await listTaskRuns(10);
    assert.ok(tasks.some(task => task.id === id));

    const succeeded = await updateTaskRun(id, { status: 'succeeded', metadata: { stage: 'done' } });
    assert.equal(succeeded?.status, 'succeeded');
    assert.ok(succeeded?.completedAt);
    assert.equal(succeeded?.leaseExpiresAt, undefined);

    const noActiveDuplicate = await findActiveTaskRunByDedupeKey(`dedupe-${id}`);
    assert.equal(noActiveDuplicate, null);
  } finally {
    await closeDb().catch(() => undefined);
  }
});

test('expired leases are recoverable from the database', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  try {
    await ensureTaskRunStore();
    const id = `task-expired-${Date.now()}`;
    await createTaskRun({
      id,
      sessionId: 'session-expired',
      workspaceRoot: '/tmp/workspace',
      toolMode: 'project-write',
      promptPreview: 'expired',
      status: 'queued',
    });
    await updateTaskRun(id, {
      status: 'running',
      nodeId: 'node-expired',
      leaseExpiresAt: new Date(Date.now() - 1_000),
      heartbeatAt: new Date(Date.now() - 2_000),
    });

    const recovered = await recoverExpiredTaskRuns('test_expired');
    assert.ok(recovered.some(task => task.id === id && task.status === 'failed'));

    const loaded = await loadTaskRun(id);
    assert.equal(loaded?.status, 'failed');
    assert.equal(loaded?.metadata.recoveryReason, 'test_expired');
  } finally {
    await closeDb().catch(() => undefined);
  }
});

test('startup recovery advisory lock skips duplicate recovery owners', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const id = `task-lock-${Date.now()}`;
  const lockKey = TASK_RUN_STARTUP_RECOVERY_LOCK_KEY + 101;
  try {
    await ensureTaskRunStore();
    await createTaskRun({
      id,
      sessionId: 'session-lock',
      workspaceRoot: '/tmp/workspace',
      toolMode: 'project-write',
      promptPreview: 'lock',
      status: 'queued',
    });
    await updateTaskRun(id, {
      status: 'running',
      nodeId: 'node-lock',
      leaseExpiresAt: new Date(Date.now() - 1_000),
      heartbeatAt: new Date(Date.now() - 2_000),
    });

    await withDbClient(async (client) => {
      const lock = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
        [lockKey],
      );
      assert.equal(lock.rows[0]?.acquired, true);
      try {
        const skipped = await recoverExpiredTaskRunsWithAdvisoryLock('test_lock_skipped', lockKey);
        assert.equal(skipped.lockAcquired, false);
        assert.equal(skipped.recovered.length, 0);
      } finally {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey]);
      }
    });

    const stillRunning = await loadTaskRun(id);
    assert.equal(stillRunning?.status, 'running');

    const recovered = await recoverExpiredTaskRunsWithAdvisoryLock('test_lock_acquired', lockKey);
    assert.equal(recovered.lockAcquired, true);
    assert.ok(recovered.recovered.some(task => task.id === id && task.status === 'failed'));

    const loaded = await loadTaskRun(id);
    assert.equal(loaded?.status, 'failed');
    assert.equal(loaded?.metadata.recoveryReason, 'test_lock_acquired');
  } finally {
    await closeDb().catch(() => undefined);
  }
});
