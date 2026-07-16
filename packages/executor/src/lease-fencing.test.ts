import test from 'node:test';
import assert from 'node:assert/strict';

import { getDb } from '@los/infra/db';
import { claimReadyAgentTasks, createAgentTask, createTaskRun } from '@los/agent';
import { _renewTaskLease } from './lease-fencing.js';

test('remote executor aborts when the agent-task fence is lost', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const graphId = `executor-lease-${suffix}`;
  const agentTaskId = `${graphId}-task`;
  const taskRunId = `executor-run-${suffix}`;
  const sessionId = `executor-session-${suffix}`;
  const nodeId = 'executor-node-a';

  try {
    await createAgentTask({
      id: agentTaskId,
      graphId,
      sessionId,
      role: 'executor',
      title: 'Remote executor lease test',
    });
    const [claimed] = await claimReadyAgentTasks({ graphId, nodeId, leaseMs: 30_000 });
    assert.ok(claimed);

    await createTaskRun({
      id: taskRunId,
      sessionId,
      nodeId,
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      promptPreview: 'remote executor lease test',
      leaseVersion: claimed.leaseVersion,
      leaseExpiresAt: new Date(Date.now() + 30_000),
    });
    await getDb().query(
      'UPDATE agent_tasks SET lease_version = lease_version + 1 WHERE id = $1',
      [agentTaskId],
    );

    const controller = new AbortController();
    await _renewTaskLease(
      taskRunId,
      nodeId,
      claimed.leaseVersion,
      { taskId: agentTaskId, leaseVersion: claimed.leaseVersion },
      30_000,
      controller,
    );

    assert.equal(controller.signal.aborted, true);
    assert.match(String(controller.signal.reason), /lease_lost/);
  } finally {
    await getDb().query('DELETE FROM task_runs WHERE id = $1', [taskRunId]).catch(() => undefined);
    await getDb().query('DELETE FROM agent_tasks WHERE graph_id = $1', [graphId]).catch(() => undefined);
  }
});
