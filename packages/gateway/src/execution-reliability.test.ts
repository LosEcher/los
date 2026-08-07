import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  claimReadyAgentTasks,
  createAgentTask,
  createAgentTaskAttempt,
  heartbeatAgentTask,
  listAgentTasksForGraph,
  updateAgentTaskStatus,
} from '@los/agent/agent-task-graph';
import { publishExecutionOutboxBatch } from '@los/agent/execution-outbox';
import { _LeaseLostError, transitionExecutionState } from '@los/agent/execution-store';
import { listSessionEvents } from '@los/agent/session-events';
import { createTaskRun, heartbeatTaskRun, loadTaskRun } from '@los/agent/task-runs';
import { createRunSpec, loadRunSpec } from '@los/agent/run-specs';
import { reapExpiredExecutionLeases, recoverStaleRunningRunSpecs } from './execution-lease-reaper.js';

test('two gateways preserve long work and recover crash, notify, and lease failures', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const graphId = `graph-reliability-${suffix}`;
  const agentTaskId = `${graphId}-task`;
  const taskRunId = `task-reliability-${suffix}`;
  const sessionId = `session-reliability-${suffix}`;
  const gatewayA = 'gateway-reliability-a';
  const gatewayB = 'gateway-reliability-b';
  const gatewayC = 'gateway-reliability-c';

  try {
    await createAgentTask({
      id: agentTaskId,
      graphId,
      sessionId,
      role: 'executor',
      title: 'Composite reliability task',
      maxAttempts: 3,
    });
    const [claimed] = await claimReadyAgentTasks({ graphId, nodeId: gatewayA, leaseMs: 1_000 });
    assert.ok(claimed);

    await createTaskRun({
      id: taskRunId,
      sessionId,
      nodeId: gatewayA,
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      promptPreview: 'composite reliability acceptance',
      leaseVersion: claimed.leaseVersion,
      leaseExpiresAt: new Date(Date.now() + 1_000),
    });
    const running = await transitionExecutionState({
      entityType: 'task_run',
      entityId: taskRunId,
      to: 'running',
      reason: 'composite_reliability_start',
      nodeId: gatewayA,
      leaseVersion: claimed.leaseVersion,
    });
    await createAgentTaskAttempt({
      id: `${agentTaskId}-attempt-1`,
      graphId,
      taskId: agentTaskId,
      attempt: 1,
      status: 'running',
      nodeId: gatewayA,
      taskRunId,
    });

    await simulatePublisherCrash(running.outboxId, gatewayA);
    const notifyFailure = await publishExecutionOutboxBatch({
      ownerId: gatewayB,
      claimMs: 1_000,
      baseDelayMs: 100,
      publish: async () => { throw new Error('notify unavailable'); },
    });
    assert.deepEqual(notifyFailure, { claimed: 1, published: 0, retried: 1 });
    await getDb().query(
      "UPDATE execution_outbox SET next_attempt_at = now() - interval '1 day' WHERE id = $1",
      [running.outboxId],
    );

    let releasePublish!: () => void;
    let signalClaimed!: () => void;
    const publishBlocked = new Promise<void>(resolve => { releasePublish = resolve; });
    const publishClaimed = new Promise<void>(resolve => { signalClaimed = resolve; });
    const retryingGateway = publishExecutionOutboxBatch({
      ownerId: gatewayB,
      claimMs: 1_000,
      publish: async record => {
        assert.equal(record.id, running.outboxId);
        signalClaimed();
        await publishBlocked;
      },
    });
    await publishClaimed;
    const competingGateway = await publishExecutionOutboxBatch({
      ownerId: gatewayC,
      claimMs: 1_000,
      publish: async () => undefined,
    });
    assert.deepEqual(competingGateway, { claimed: 0, published: 0, retried: 0 });
    releasePublish();
    assert.deepEqual(await retryingGateway, { claimed: 1, published: 1, retried: 0 });

    for (let index = 0; index < 5; index++) {
      await delay(300);
      const [taskRunHeartbeat, agentTaskHeartbeat] = await Promise.all([
        heartbeatTaskRun(taskRunId, {
          nodeId: gatewayA,
          leaseVersion: claimed.leaseVersion,
          leaseMs: 1_000,
        }),
        heartbeatAgentTask(agentTaskId, {
          nodeId: gatewayA,
          leaseVersion: claimed.leaseVersion,
          leaseMs: 1_000,
        }),
      ]);
      assert.ok(taskRunHeartbeat);
      assert.ok(agentTaskHeartbeat);
    }

    const healthySweep = await reapExpiredExecutionLeases('gateway_b_long_task_sweep');
    assert.deepEqual(healthySweep, { taskRuns: 0, agentTasks: 0, exhaustedAgentTasks: 0 });
    assert.equal((await loadTaskRun(taskRunId))?.status, 'running');

    await delay(1_100);
    await assert.rejects(
      transitionExecutionState({
        entityType: 'task_run',
        entityId: taskRunId,
        to: 'succeeded',
        reason: 'stale_gateway_completion',
        nodeId: gatewayA,
        leaseVersion: claimed.leaseVersion,
      }),
      _LeaseLostError,
    );

    const recoverySweeps = await Promise.all([
      reapExpiredExecutionLeases('gateway_b_crash_recovery'),
      reapExpiredExecutionLeases('gateway_c_crash_recovery'),
    ]);
    assert.equal(recoverySweeps.reduce((sum, result) => sum + result.taskRuns, 0), 1);
    assert.equal(recoverySweeps.reduce((sum, result) => sum + result.agentTasks, 0), 1);
    assert.equal(recoverySweeps.reduce((sum, result) => sum + result.exhaustedAgentTasks, 0), 0);
    assert.equal((await loadTaskRun(taskRunId))?.status, 'failed');

    const [reclaimed] = await claimReadyAgentTasks({ graphId, nodeId: gatewayC, leaseMs: 1_000 });
    assert.ok(reclaimed);
    assert.ok(reclaimed.leaseVersion > claimed.leaseVersion);
    const staleAgentCompletion = await updateAgentTaskStatus(
      agentTaskId,
      'succeeded',
      { source: gatewayA },
      { nodeId: gatewayA, leaseVersion: claimed.leaseVersion },
    );
    assert.equal(staleAgentCompletion, null);
    assert.equal(
      (await listAgentTasksForGraph(graphId)).find(task => task.id === agentTaskId)?.claimedByNodeId,
      gatewayC,
    );

    const events = await listSessionEvents(sessionId, 100);
    assert.ok(events.some(event => event.type === 'task_run.failed'));
    assert.ok(events.some(event => event.type === 'agent_task.requeued'));
    const deadLetters = await getDb().query<{ reason: string }>(
      'SELECT reason FROM dead_letter_events WHERE task_run_id = $1 ORDER BY created_at',
      [taskRunId],
    );
    assert.deepEqual(deadLetters.rows.map(row => row.reason), ['lease_expired']);
  } finally {
    await cleanupReliabilityFixtures({ graphId, sessionId, taskRunId });
    await closeDb().catch(() => undefined);
  }
});

async function simulatePublisherCrash(outboxId: number, ownerId: string): Promise<void> {
  await getDb().query(
    `UPDATE execution_outbox
     SET claimed_by = $2,
         claimed_at = now() - interval '2 seconds',
         attempts = attempts + 1,
         next_attempt_at = now() - interval '1 day'
     WHERE id = $1`,
    [outboxId, ownerId],
  );
}

async function cleanupReliabilityFixtures(input: {
  graphId: string;
  sessionId: string;
  taskRunId: string;
}): Promise<void> {
  const db = getDb();
  await db.query('DELETE FROM dead_letter_events WHERE task_run_id = $1', [input.taskRunId]).catch(() => undefined);
  await db.query('DELETE FROM execution_outbox WHERE session_id = $1', [input.sessionId]).catch(() => undefined);
  await db.query(
    "DELETE FROM session_events WHERE session_id = $1 OR (source = 'dead_letter' AND payload_json->>'taskRunId' = $2)",
    [input.sessionId, input.taskRunId],
  ).catch(() => undefined);
  await db.query('DELETE FROM task_attempts WHERE graph_id = $1', [input.graphId]).catch(() => undefined);
  await db.query('DELETE FROM scheduler_decisions WHERE graph_id = $1', [input.graphId]).catch(() => undefined);
  await db.query('DELETE FROM task_runs WHERE id = $1', [input.taskRunId]).catch(() => undefined);
  await db.query('DELETE FROM agent_tasks WHERE graph_id = $1', [input.graphId]).catch(() => undefined);
}

test('stale-running sweep blocks orphaned run_specs and preserves active ones', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const staleRunSpecId = `run-stale-sweep-${suffix}`;
  const activeRunSpecId = `run-stale-sweep-active-${suffix}`;
  const sessionId = `session-stale-sweep-${suffix}`;
  const activeTaskRunId = `task-stale-sweep-active-${suffix}`;
  const db = getDb();

  try {
    // Stale fixture: run_spec in running with no task, updated 40min ago.
    await createRunSpec({ id: staleRunSpecId, sessionId, prompt: 'stale sweep fixture', workspaceRoot: '/tmp', toolMode: 'read-only' });
    await transitionExecutionState({ entityType: 'run_spec', entityId: staleRunSpecId, to: 'running', sessionId, reason: 'test fixture' });
    await db.query('UPDATE run_specs SET updated_at = now() - interval \'40 minutes\' WHERE id = $1', [staleRunSpecId]);

    // Active fixture: run_spec in running with a live running task.
    await createRunSpec({ id: activeRunSpecId, sessionId, prompt: 'active sweep fixture', workspaceRoot: '/tmp', toolMode: 'read-only' });
    await transitionExecutionState({ entityType: 'run_spec', entityId: activeRunSpecId, to: 'running', sessionId, reason: 'test fixture' });
    await createTaskRun({
      id: activeTaskRunId,
      runSpecId: activeRunSpecId,
      sessionId,
      promptPreview: 'active sweep task',
      workspaceRoot: '/tmp',
      toolMode: 'read-only',
      status: 'running',
    });

    const sweep = await recoverStaleRunningRunSpecs({ maxAgeMinutes: 30 });

    assert.equal(sweep.scanned, 1, 'only the stale run_spec should match the scan');
    assert.equal(sweep.recovered, 1, 'the stale run_spec should be transitioned to blocked');
    const stale = await loadRunSpec(staleRunSpecId);
    assert.equal(stale?.status, 'blocked', 'stale run_spec must end up blocked (AP1 path)');
    const active = await loadRunSpec(activeRunSpecId);
    assert.equal(active?.status, 'running', 'run_spec with an active task must be left alone');
  } finally {
    const ids = [staleRunSpecId, activeRunSpecId];
    await db.query('DELETE FROM verification_records WHERE run_spec_id = ANY($1)', [ids]).catch(() => undefined);
    await db.query('DELETE FROM task_runs WHERE id = $1', [activeTaskRunId]).catch(() => undefined);
    await db.query('DELETE FROM execution_outbox WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await db.query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await db.query('DELETE FROM run_specs WHERE id = ANY($1)', [ids]).catch(() => undefined);
  }
});

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
