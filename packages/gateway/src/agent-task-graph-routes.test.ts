import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  approveRunSpecPhase,
  createAgentTask,
  createAgentTaskAttempt,
  createRunSpec,
  ensureAgentTaskGraphStore,
  linkAgentTaskDependency,
  updateAgentTaskStatus,
} from '@los/agent';
import { registerAgentTaskGraphRoutes } from './routes/orchestration/agent-task-graph-routes.js';

test('agent task graph routes expose read model and completion status', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const graphId = `gateway-graph-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const app = Fastify({ logger: false });
  registerAgentTaskGraphRoutes(app);

  try {
    await ensureAgentTaskGraphStore();
    await createAgentTask({ id: `${graphId}-plan`, graphId, role: 'planner', title: 'Plan work' });
    await createAgentTask({ id: `${graphId}-exec`, graphId, role: 'executor', title: 'Implement work' });
    await createAgentTask({ id: `${graphId}-verify`, graphId, role: 'verifier', title: 'Verify work' });
    await linkAgentTaskDependency({ graphId, taskId: `${graphId}-exec`, dependsOnTaskId: `${graphId}-plan` });
    await linkAgentTaskDependency({ graphId, taskId: `${graphId}-verify`, dependsOnTaskId: `${graphId}-exec` });
    await updateAgentTaskStatus(`${graphId}-plan`, 'succeeded');
    await updateAgentTaskStatus(`${graphId}-exec`, 'succeeded');
    await updateAgentTaskStatus(`${graphId}-verify`, 'succeeded');
    await createAgentTaskAttempt({
      id: `${graphId}-verify-attempt-1`,
      graphId,
      taskId: `${graphId}-verify`,
      status: 'succeeded',
      verificationRecordId: 'verification-route-ok',
    });

    const graphResponse = await app.inject({
      method: 'GET',
      url: `/agent-graphs/${graphId}?requireVerifier=true`,
    });
    assert.equal(graphResponse.statusCode, 200);
    const graph = graphResponse.json();
    assert.equal(graph.completion.status, 'succeeded');
    assert.equal(graph.completion.canComplete, true);
    assert.equal(graph.tasks.length, 3);
    assert.equal(graph.edges.length, 2);
    assert.equal(graph.attemptsByTaskId[`${graphId}-verify`][0].verificationRecordId, 'verification-route-ok');

    const completionResponse = await app.inject({
      method: 'GET',
      url: `/agent-graphs/${graphId}/completion?requireVerifier=true`,
    });
    assert.equal(completionResponse.statusCode, 200);
    assert.equal(completionResponse.json().status, 'succeeded');
  } finally {
    await cleanupGraph(graphId);
    await closeDb().catch(() => undefined);
    await app.close();
  }
});

test('operator creates, watches, cancels, and integrates a governed graph after verifier success', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const graphId = `governed-graph-${suffix}`;
  const cancelGraphId = `governed-cancel-${suffix}`;
  const runSpecId = `governed-run-${suffix}`;
  const sessionId = `governed-session-${suffix}`;
  const app = Fastify({ logger: false });
  registerAgentTaskGraphRoutes(app);

  try {
    await createRunSpec({
      id: runSpecId,
      sessionId,
      userId: 'local-user',
      prompt: 'implement governed graph',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      runContract: {
        mode: 'execution',
        executionMode: 'standard',
        phase: 'planning',
        requiredChecks: ['pnpm --filter @los/agent check'],
        plan: [{
          id: 'step-1',
          title: 'Implement graph workers',
          description: 'Exercise bounded graph controls.',
          dependsOnIds: [],
          editableSurfaces: ['packages/agent', 'packages/web'],
          completionCriteria: 'Verifier succeeds.',
        }],
      },
    });
    await approveRunSpecPhase(runSpecId, { actor: 'local-user' });

    const createResponse = await app.inject({
      method: 'POST',
      url: '/agent-graphs',
      payload: graphPayload(graphId, runSpecId),
    });
    assert.equal(createResponse.statusCode, 201, createResponse.body);
    assert.equal(createResponse.json().control.integrationStatus, 'pending_verification');

    const watchResponse = await app.inject({ method: 'GET', url: `/agent-graphs/${graphId}/watch` });
    assert.equal(watchResponse.statusCode, 200);
    assert.equal(watchResponse.json().tasks.length, 3);
    assert.equal(watchResponse.json().control.integrationOwner, 'local-user');

    const blockedIntegration = await app.inject({
      method: 'POST',
      url: `/agent-graphs/${graphId}/integrate`,
      payload: { note: 'too early' },
    });
    assert.equal(blockedIntegration.statusCode, 409);
    assert.match(blockedIntegration.json().error, /verification gate blocks integration/);

    for (const taskId of [`${graphId}-worker-a`, `${graphId}-worker-b`, `${graphId}-verifier`]) {
      await updateAgentTaskStatus(taskId, 'succeeded');
    }
    const integrated = await app.inject({
      method: 'POST',
      url: `/agent-graphs/${graphId}/integrate`,
      payload: { note: 'operator reviewed verifier evidence' },
    });
    assert.equal(integrated.statusCode, 200, integrated.body);
    assert.equal(integrated.json().control.integrationStatus, 'integrated');
    assert.equal(integrated.json().control.events.at(-1).payload.operatorIntervention, true);

    const cancelCreate = await app.inject({
      method: 'POST',
      url: '/agent-graphs',
      payload: graphPayload(cancelGraphId, runSpecId),
    });
    assert.equal(cancelCreate.statusCode, 201, cancelCreate.body);
    const cancelled = await app.inject({
      method: 'POST',
      url: `/agent-graphs/${cancelGraphId}/cancel`,
      payload: { reason: 'operator stopped graph' },
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().control.integrationStatus, 'cancelled');
    assert.ok(cancelled.json().graph.tasks.every((task: { status: string }) => task.status === 'cancelled'));

    const completedCancelGraphId = `governed-completed-cancel-${suffix}`;
    const completedCancelCreate = await app.inject({
      method: 'POST',
      url: '/agent-graphs',
      payload: graphPayload(completedCancelGraphId, runSpecId),
    });
    assert.equal(completedCancelCreate.statusCode, 201, completedCancelCreate.body);
    for (const taskId of [`${completedCancelGraphId}-worker-a`, `${completedCancelGraphId}-worker-b`, `${completedCancelGraphId}-verifier`]) {
      await updateAgentTaskStatus(taskId, 'succeeded');
    }
    const completedCancelled = await app.inject({
      method: 'POST',
      url: `/agent-graphs/${completedCancelGraphId}/cancel`,
      payload: { reason: 'operator stopped completed graph' },
    });
    assert.equal(completedCancelled.statusCode, 200, completedCancelled.body);
    assert.equal(completedCancelled.json().control.integrationStatus, 'cancelled');
    await cleanupGraph(completedCancelGraphId);
  } finally {
    await cleanupGraph(graphId);
    await cleanupGraph(cancelGraphId);
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
    await app.close();
  }
});

async function cleanupGraph(graphId: string): Promise<void> {
  await getDb().query('DELETE FROM task_attempts WHERE graph_id = $1', [graphId]).catch(() => undefined);
  await getDb().query('DELETE FROM task_edges WHERE graph_id = $1', [graphId]).catch(() => undefined);
  await getDb().query('DELETE FROM agent_tasks WHERE graph_id = $1', [graphId]).catch(() => undefined);
}

function graphPayload(graphId: string, runSpecId: string) {
  return {
    graphId,
    runSpecId,
    integrationOwner: 'local-user',
    maxParallelTasks: 2,
    workers: [
      { id: `${graphId}-worker-a`, title: 'Implement agent surface', editableSurfaces: ['packages/agent'] },
      { id: `${graphId}-worker-b`, title: 'Implement web surface', editableSurfaces: ['packages/web'] },
    ],
    verifier: { id: `${graphId}-verifier`, title: 'Verify graph output' },
  };
}
