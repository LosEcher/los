import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  claimReadyAgentTasks,
  createAgentTask,
  createAgentTaskAttempt,
  ensureAgentTaskGraphStore,
  linkAgentTaskDependency,
  listAgentTaskAttempts,
  listBlockedAgentTasks,
  updateAgentTaskStatus,
} from './agent-task-graph.js';
import {
  readAgentTaskGraph,
  getAgentTaskGraphCompletion,
} from './agent-task-graph-read-model.js';

test('agent task graph claims independent tasks and blocks failed dependencies', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const graphId = `graph-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await ensureAgentTaskGraphStore();
    await createAgentTask({ id: `${graphId}-plan`, graphId, role: 'planner', title: 'Plan work', priority: 10 });
    await createAgentTask({ id: `${graphId}-exec-a`, graphId, role: 'executor', title: 'Implement A', priority: 20 });
    await createAgentTask({ id: `${graphId}-exec-b`, graphId, role: 'executor', title: 'Implement B', priority: 20 });
    await createAgentTask({ id: `${graphId}-verify`, graphId, role: 'verifier', title: 'Verify work', priority: 30 });
    await linkAgentTaskDependency({ graphId, taskId: `${graphId}-exec-a`, dependsOnTaskId: `${graphId}-plan` });
    await linkAgentTaskDependency({ graphId, taskId: `${graphId}-exec-b`, dependsOnTaskId: `${graphId}-plan` });
    await linkAgentTaskDependency({ graphId, taskId: `${graphId}-verify`, dependsOnTaskId: `${graphId}-exec-a` });
    await linkAgentTaskDependency({ graphId, taskId: `${graphId}-verify`, dependsOnTaskId: `${graphId}-exec-b` });

    const first = await claimReadyAgentTasks({ graphId, limit: 2, nodeId: 'node-a' });
    assert.deepEqual(first.map(task => task.id), [`${graphId}-plan`]);
    await updateAgentTaskStatus(`${graphId}-plan`, 'succeeded');

    const independent = await claimReadyAgentTasks({ graphId, limit: 2, nodeId: 'node-a' });
    assert.deepEqual(independent.map(task => task.id).sort(), [`${graphId}-exec-a`, `${graphId}-exec-b`].sort());
    await updateAgentTaskStatus(`${graphId}-exec-a`, 'succeeded');
    await updateAgentTaskStatus(`${graphId}-exec-b`, 'failed');

    const blocked = await listBlockedAgentTasks(graphId);
    assert.deepEqual(blocked.map(task => task.id), [`${graphId}-verify`]);
    const afterFailure = await claimReadyAgentTasks({ graphId, limit: 2, nodeId: 'node-a' });
    assert.deepEqual(afterFailure, []);
  } finally {
    await cleanupGraph(graphId);
    await closeDb().catch(() => undefined);
  }
});

test('agent task graph treats missing upstream dependencies as unmet', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const graphId = `graph-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await ensureAgentTaskGraphStore();
    await createAgentTask({ id: `${graphId}-exec`, graphId, role: 'executor', title: 'Implement task' });
    await linkAgentTaskDependency({ graphId, taskId: `${graphId}-exec`, dependsOnTaskId: `${graphId}-missing-plan` });

    const beforeUpstreamExists = await claimReadyAgentTasks({ graphId, limit: 2, nodeId: 'node-a' });
    assert.deepEqual(beforeUpstreamExists, []);

    await createAgentTask({ id: `${graphId}-missing-plan`, graphId, role: 'planner', title: 'Plan task' });
    const plannerOnly = await claimReadyAgentTasks({ graphId, limit: 2, nodeId: 'node-a' });
    assert.deepEqual(plannerOnly.map(task => task.id), [`${graphId}-missing-plan`]);

    await updateAgentTaskStatus(`${graphId}-missing-plan`, 'succeeded');
    const afterUpstreamSuccess = await claimReadyAgentTasks({ graphId, limit: 2, nodeId: 'node-a' });
    assert.deepEqual(afterUpstreamSuccess.map(task => task.id), [`${graphId}-exec`]);
  } finally {
    await cleanupGraph(graphId);
    await closeDb().catch(() => undefined);
  }
});

test('agent task attempts preserve retry and verifier evidence links', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const graphId = `graph-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const taskId = `${graphId}-verify`;
  try {
    await ensureAgentTaskGraphStore();
    await createAgentTask({
      id: taskId,
      graphId,
      role: 'verifier',
      title: 'Verify final state',
      maxAttempts: 2,
    });
    await createAgentTaskAttempt({
      id: `${taskId}-attempt-1`,
      graphId,
      taskId,
      attempt: 1,
      status: 'failed',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      nodeId: 'node-a',
      verificationRecordId: 'verification-1',
      toolCallStateIds: ['tool-1', 'tool-1', 'tool-2'],
      error: 'missing evidence',
    });
    await createAgentTaskAttempt({
      id: `${taskId}-attempt-2`,
      graphId,
      taskId,
      attempt: 2,
      status: 'succeeded',
      verificationRecordId: 'verification-2',
      outputSummary: 'required checks passed',
    });

    const attempts = await listAgentTaskAttempts(taskId);
    assert.deepEqual(attempts.map(attempt => attempt.status), ['failed', 'succeeded']);
    assert.deepEqual(attempts[0]?.toolCallStateIds, ['tool-1', 'tool-2']);
    assert.equal(attempts[0]?.verificationRecordId, 'verification-1');
    assert.equal(attempts[1]?.verificationRecordId, 'verification-2');
  } finally {
    await cleanupGraph(graphId);
    await closeDb().catch(() => undefined);
  }
});

test('agent task graph read model reports completion decisions', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const graphId = `graph-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await ensureAgentTaskGraphStore();
    await createAgentTask({ id: `${graphId}-plan`, graphId, role: 'planner', title: 'Plan work' });
    await createAgentTask({ id: `${graphId}-exec`, graphId, role: 'executor', title: 'Implement work' });
    await createAgentTask({ id: `${graphId}-verify`, graphId, role: 'verifier', title: 'Verify work' });
    await linkAgentTaskDependency({ graphId, taskId: `${graphId}-exec`, dependsOnTaskId: `${graphId}-plan` });
    await linkAgentTaskDependency({ graphId, taskId: `${graphId}-verify`, dependsOnTaskId: `${graphId}-exec` });
    await createAgentTaskAttempt({
      id: `${graphId}-verify-attempt-1`,
      graphId,
      taskId: `${graphId}-verify`,
      attempt: 1,
      status: 'succeeded',
      verificationRecordId: 'verification-ok',
    });

    let completion = await getAgentTaskGraphCompletion(graphId, { requireVerifier: true });
    assert.equal(completion.status, 'in_progress');
    assert.deepEqual(completion.readyTaskIds, [`${graphId}-plan`]);

    await updateAgentTaskStatus(`${graphId}-plan`, 'succeeded');
    await updateAgentTaskStatus(`${graphId}-exec`, 'succeeded');
    await updateAgentTaskStatus(`${graphId}-verify`, 'succeeded');

    const graph = await readAgentTaskGraph(graphId, { requireVerifier: true });
    completion = graph.completion;
    assert.equal(completion.status, 'succeeded');
    assert.equal(completion.canComplete, true);
    assert.deepEqual(completion.succeededVerifierTaskIds, [`${graphId}-verify`]);
    assert.equal(graph.edges.length, 2);
    assert.equal(graph.attemptsByTaskId[`${graphId}-verify`]?.[0]?.verificationRecordId, 'verification-ok');
  } finally {
    await cleanupGraph(graphId);
    await closeDb().catch(() => undefined);
  }
});

test('agent task graph completion requires verifier when requested', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const graphId = `graph-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await ensureAgentTaskGraphStore();
    await createAgentTask({ id: `${graphId}-exec`, graphId, role: 'executor', title: 'Implement work' });
    await updateAgentTaskStatus(`${graphId}-exec`, 'succeeded');

    const completion = await getAgentTaskGraphCompletion(graphId, { requireVerifier: true });
    assert.equal(completion.status, 'blocked');
    assert.equal(completion.canComplete, false);
    assert.equal(completion.reason, 'succeeded verifier task is required for completion');
  } finally {
    await cleanupGraph(graphId);
    await closeDb().catch(() => undefined);
  }
});

async function cleanupGraph(graphId: string): Promise<void> {
  await getDb().query('DELETE FROM task_attempts WHERE graph_id = $1', [graphId]).catch(() => undefined);
  await getDb().query('DELETE FROM task_edges WHERE graph_id = $1', [graphId]).catch(() => undefined);
  await getDb().query('DELETE FROM agent_tasks WHERE graph_id = $1', [graphId]).catch(() => undefined);
}
