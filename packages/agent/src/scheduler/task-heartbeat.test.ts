import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { claimReadyAgentTasks, createAgentTask } from '../agent-task-graph.js';
import { createTaskRun } from '../task-runs.js';
import { transitionExecutionState } from '../execution-store.js';
import { getScheduledTaskAbortReason, registerScheduledTaskController } from './abort-registry.js';
import { startTaskHeartbeat } from './task-heartbeat.js';

test('dual heartbeat aborts when the agent-task fence is lost', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const graphId = `graph-heartbeat-${suffix}`;
  const agentTaskId = `${graphId}-task`;
  const taskRunId = `task-heartbeat-${suffix}`;
  const sessionId = `session-heartbeat-${suffix}`;
  try {
    await createAgentTask({ id: agentTaskId, graphId, sessionId, role: 'executor', title: 'Heartbeat task' });
    const [task] = await claimReadyAgentTasks({ graphId, nodeId: 'node-a', leaseMs: 30_000 });
    assert.ok(task);
    await createTaskRun({
      id: taskRunId,
      sessionId,
      nodeId: 'node-a',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      promptPreview: 'heartbeat',
      leaseVersion: task.leaseVersion,
      leaseExpiresAt: new Date(Date.now() + 30_000),
    });
    await transitionExecutionState({
      entityType: 'task_run',
      entityId: taskRunId,
      to: 'running',
      reason: 'heartbeat_test_start',
      nodeId: 'node-a',
      leaseVersion: task.leaseVersion,
    });

    const controller = new AbortController();
    const unregister = registerScheduledTaskController(taskRunId, controller, 'cancelled');
    const stop = startTaskHeartbeat(taskRunId, 'node-a', task.leaseVersion, 30_000, 25, {
      agentTaskLease: { taskId: agentTaskId, leaseVersion: task.leaseVersion },
    });
    await delay(50);
    await getDb().query('UPDATE agent_tasks SET lease_version = lease_version + 1 WHERE id = $1', [agentTaskId]);
    await waitForAbort(controller.signal);
    assert.equal(getScheduledTaskAbortReason(taskRunId), 'lease_lost');
    stop();
    unregister();
  } finally {
    await getDb().query('DELETE FROM execution_outbox WHERE entity_id = $1', [taskRunId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE id = $1', [taskRunId]).catch(() => undefined);
    await getDb().query('DELETE FROM agent_tasks WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await Promise.race([
    new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })),
    delay(2_000).then(() => { throw new Error('heartbeat did not abort after lease loss'); }),
  ]);
}
