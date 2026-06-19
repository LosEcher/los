import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  createAgentTask,
  createAgentTaskAttempt,
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

async function cleanupGraph(graphId: string): Promise<void> {
  await getDb().query('DELETE FROM task_attempts WHERE graph_id = $1', [graphId]).catch(() => undefined);
  await getDb().query('DELETE FROM task_edges WHERE graph_id = $1', [graphId]).catch(() => undefined);
  await getDb().query('DELETE FROM agent_tasks WHERE graph_id = $1', [graphId]).catch(() => undefined);
}
