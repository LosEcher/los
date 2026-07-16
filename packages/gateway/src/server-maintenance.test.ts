import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  claimReadyAgentTasks,
  createAgentTask,
  createAgentTaskAttempt,
  listAgentTasksForGraph,
} from '@los/agent/agent-task-graph';
import { createTaskRun, loadTaskRun } from '@los/agent/task-runs';
import { transitionExecutionState } from '@los/agent/execution-store';
import { listSessionEvents } from '@los/agent/session-events';
import { reapExpiredExecutionLeases } from './server-maintenance.js';

test('periodic lease reaper fails exhausted graph work and records durable evidence', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const graphId = `graph-reaper-${suffix}`;
  const agentTaskId = `${graphId}-task`;
  const taskRunId = `task-reaper-${suffix}`;
  const sessionId = `session-reaper-${suffix}`;
  try {
    await createAgentTask({
      id: agentTaskId,
      graphId,
      sessionId,
      role: 'executor',
      title: 'Expire this task',
      maxAttempts: 1,
    });
    const [claimed] = await claimReadyAgentTasks({ graphId, nodeId: 'node-reaper', leaseMs: 30_000 });
    assert.ok(claimed);
    await createTaskRun({
      id: taskRunId,
      sessionId,
      nodeId: 'node-reaper',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      promptPreview: 'expire this run',
      leaseVersion: claimed.leaseVersion,
      leaseExpiresAt: new Date(Date.now() + 30_000),
    });
    await transitionExecutionState({
      entityType: 'task_run',
      entityId: taskRunId,
      to: 'running',
      reason: 'reaper_test_start',
      nodeId: 'node-reaper',
      leaseVersion: claimed.leaseVersion,
    });
    await createAgentTaskAttempt({
      id: `${agentTaskId}-attempt-1`,
      graphId,
      taskId: agentTaskId,
      attempt: 1,
      status: 'running',
      nodeId: 'node-reaper',
      taskRunId,
    });
    await getDb().query(
      'UPDATE task_runs SET lease_expires_at = now() - interval \'1 second\' WHERE id = $1',
      [taskRunId],
    );
    await getDb().query(
      'UPDATE agent_tasks SET lease_expires_at = now() - interval \'1 second\' WHERE id = $1',
      [agentTaskId],
    );

    const result = await reapExpiredExecutionLeases('test_periodic_reaper');
    assert.deepEqual(result, { taskRuns: 1, agentTasks: 1, exhaustedAgentTasks: 1 });
    assert.equal((await loadTaskRun(taskRunId))?.status, 'failed');
    assert.equal((await listAgentTasksForGraph(graphId)).find(task => task.id === agentTaskId)?.status, 'failed');
    assert.equal(
      (await listSessionEvents(sessionId, 100)).some(event => event.type === 'agent_task.failed'),
      true,
    );
    const deadLetters = await getDb().query<{ reason: string }>(
      'SELECT reason FROM dead_letter_events WHERE task_run_id = $1 ORDER BY created_at',
      [taskRunId],
    );
    assert.deepEqual(deadLetters.rows.map(row => row.reason).sort(), ['lease_expired', 'max_attempts']);
  } finally {
    await getDb().query('DELETE FROM dead_letter_events WHERE task_run_id = $1', [taskRunId]).catch(() => undefined);
    await getDb().query('DELETE FROM execution_outbox WHERE entity_id = $1', [taskRunId]).catch(() => undefined);
    await getDb().query(
      "DELETE FROM session_events WHERE session_id = $1 OR (source = 'dead_letter' AND payload_json->>'taskRunId' = $2)",
      [sessionId, taskRunId],
    ).catch(() => undefined);
    await getDb().query('DELETE FROM task_attempts WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE id = $1', [taskRunId]).catch(() => undefined);
    await getDb().query('DELETE FROM agent_tasks WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
