import test from 'node:test';
import assert from 'node:assert/strict';

import { closeDb, getDb, initDb, withDbClient } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import {
  createTaskRun,
  ensureTaskRunStore,
  findActiveTaskRunByDedupeKey,
  heartbeatTaskRun,
  listActiveTaskRunsForSession,
  loadTaskRun,
  listTaskRuns,
  recoverExpiredTaskRuns,
  recoverExpiredTaskRunsWithAdvisoryLock,
  updateTaskRun,
  updateTaskRunFields,
} from './task-runs.js';
import { createTaskRunOrFindActive } from './task-runs/create-or-find.js';
import { _LeaseLostError, transitionExecutionState } from './execution-store.js';

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

    const rerouted = await updateTaskRunFields(id, {
      provider: 'xai',
      model: 'grok-test',
      metadata: { ...running!.metadata, routeReason: 'explicit_fallback_policy' },
    });
    assert.equal(rerouted?.status, 'running');
    assert.equal(rerouted?.provider, 'xai');
    assert.equal(rerouted?.model, 'grok-test');
    assert.equal(rerouted?.metadata.routeReason, 'explicit_fallback_policy');

    const heartbeat = await heartbeatTaskRun(id, {
      nodeId: 'node-2',
      leaseVersion: running?.leaseVersion ?? 0,
      leaseMs: 30_000,
    });
    assert.equal(heartbeat?.nodeId, 'node-2');
    assert.ok(heartbeat?.heartbeatAt);

    const loaded = await loadTaskRun(id);
    assert.equal(loaded?.status, 'running');
    assert.ok((await listActiveTaskRunsForSession('session-1')).some(task => task.id === id));

    const tasks = await listTaskRuns(10);
    assert.ok(tasks.some(task => task.id === id));

    const succeeded = await updateTaskRun(id, { status: 'succeeded', metadata: { stage: 'done' } });
    assert.equal(succeeded?.status, 'succeeded');
    assert.ok(succeeded?.completedAt);
    assert.equal(succeeded?.leaseExpiresAt, undefined);

    const noActiveDuplicate = await findActiveTaskRunByDedupeKey(`dedupe-${id}`);
    assert.equal(noActiveDuplicate, null);
    assert.equal((await listActiveTaskRunsForSession('session-1')).some(task => task.id === id), false);
  } finally {
    await closeDb().catch(() => undefined);
  }
});

test('concurrent active dedupe creation converges on one task run', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dedupeKey = `dedupe-race-${suffix}`;
  const ids = [`task-race-a-${suffix}`, `task-race-b-${suffix}`];
  try {
    const results = await Promise.all(ids.map((id) => createTaskRunOrFindActive({
      id,
      sessionId: `session-${id}`,
      dedupeKey,
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      promptPreview: 'concurrent dedupe fixture',
    })));

    assert.equal(results.filter(result => result.created).length, 1);
    assert.equal(new Set(results.map(result => result.taskRun.id)).size, 1);
    const rows = await getDb().query<{ id: string }>(
      `SELECT id FROM task_runs WHERE dedupe_key = $1 AND status IN ('queued', 'running')`,
      [dedupeKey],
    );
    assert.equal(rows.rows.length, 1);
  } finally {
    await getDb().query('DELETE FROM task_runs WHERE id = ANY($1::text[])', [ids]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('task run terminal transitions reject stale lease owners', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const id = `task-lease-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    const created = await createTaskRun({
      id,
      sessionId: `session-${id}`,
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      promptPreview: 'lease test',
      nodeId: 'node-a',
      leaseVersion: 7,
      leaseExpiresAt: new Date(Date.now() + 30_000),
    });
    assert.equal(created.leaseVersion, 7);
    await transitionExecutionState({
      entityType: 'task_run',
      entityId: id,
      to: 'running',
      reason: 'lease_test_start',
      nodeId: 'node-a',
      leaseVersion: 7,
    });
    assert.equal((await heartbeatTaskRun(id, {
      nodeId: 'node-a',
      leaseVersion: 7,
      leaseMs: 30_000,
    }))?.leaseVersion, 7);
    assert.equal(await heartbeatTaskRun(id, {
      nodeId: 'node-b',
      leaseVersion: 7,
      leaseMs: 30_000,
    }), null);

    await getDb().query(
      'UPDATE task_runs SET node_id = $2, lease_version = $3, lease_expires_at = now() + interval \'30 seconds\' WHERE id = $1',
      [id, 'node-b', 8],
    );
    await assert.rejects(
      () => transitionExecutionState({
        entityType: 'task_run',
        entityId: id,
        to: 'succeeded',
        reason: 'stale_owner_finish',
        nodeId: 'node-a',
        leaseVersion: 7,
      }),
      _LeaseLostError,
    );
    await transitionExecutionState({
      entityType: 'task_run',
      entityId: id,
      to: 'succeeded',
      reason: 'current_owner_finish',
      nodeId: 'node-b',
      leaseVersion: 8,
    });
    assert.equal((await loadTaskRun(id))?.status, 'succeeded');
  } finally {
    await getDb().query('DELETE FROM execution_outbox WHERE entity_id = $1', [id]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [`session-${id}`]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE id = $1', [id]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('task_runs status constraint rejects invalid raw database writes', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  try {
    await ensureTaskRunStore();
    const id = `task-invalid-status-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await assert.rejects(
      () => getDb().query(
        `
        INSERT INTO task_runs (
          id, session_id, trace_id, workspace_root, tool_mode,
          provider, status, attempt, prompt_preview, metadata_json
        )
        VALUES ($1, $2, $3, '/tmp/workspace', 'project-write', 'deepseek', 'deepseek-reasoner', 1, 'invalid status', '{}'::jsonb)
      `,
        [id, `session-${id}`, `trace-${id}`],
      ),
      /task_runs_status_chk/,
    );
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

    // Pre-acquire the coordination lock to test the "skipped" path.
    // In mesh mode, this uses pg_try_advisory_lock under the hood.
    const { resolveCoordinationBackend } = await import('./coordination/resolve.js');
    const backend = await resolveCoordinationBackend();
    const releaseLock = await backend.lock.acquire('task-run-recovery');
    try {
      const skipped = await recoverExpiredTaskRunsWithAdvisoryLock('test_lock_skipped');
      assert.equal(skipped.lockAcquired, false);
      assert.equal(skipped.recovered.length, 0);
    } finally {
      await releaseLock();
    }

    const stillRunning = await loadTaskRun(id);
    assert.equal(stillRunning?.status, 'running');

    const recovered = await recoverExpiredTaskRunsWithAdvisoryLock('test_lock_acquired');
    assert.equal(recovered.lockAcquired, true);
    assert.ok(recovered.recovered.some(task => task.id === id && task.status === 'failed'));

    const loaded = await loadTaskRun(id);
    assert.equal(loaded?.status, 'failed');
    assert.equal(loaded?.metadata.recoveryReason, 'test_lock_acquired');
  } finally {
    await closeDb().catch(() => undefined);
  }
});
