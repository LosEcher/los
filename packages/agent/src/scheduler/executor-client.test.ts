import test from 'node:test';
import assert from 'node:assert/strict';

import { closeDb, getDb, initDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import { upsertExecutorNode } from '../executor-nodes.js';
import { listSchedulerDecisions } from '../scheduler-decision-ledger.js';
import { runScheduledAgentTask } from './scheduled-task-runner.js';
import { _compileExecutorRequirements, _ExecutorSelectionError, resolveExecutor } from './executor-client.js';

test('compileExecutorRequirements derives policy and compatibility requirements', () => {
  assert.deepEqual(
    _compileExecutorRequirements(
      { enabled: true, requiresBuild: true, requiredCapabilities: ['network_egress'] },
      { toolMode: 'all', sandboxMode: 'sandbox' },
    ),
    ['heavy_task_safe', 'network_egress', 'sandbox', 'shell', 'workspace_write'],
  );
});

test('resolveExecutor skips candidates missing required capabilities', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const policyNodeId = `policy-only-${suffix}`;
  const sandboxNodeId = `sandboxed-${suffix}`;
  try {
    for (const [nodeId, sandbox] of [[policyNodeId, 'tool_policy'], [sandboxNodeId, 'linux-bwrap']] as const) {
      await upsertExecutorNode({
        nodeId,
        nodeKind: 'executor',
        status: 'online',
        baseUrl: `http://127.0.0.1:${nodeId === policyNodeId ? 18091 : 18092}`,
        connectModes: ['agent_http'],
        capabilities: { run_agent: true, workspace_write: true, shell: true, sandbox },
        verified: { agent_http: { ok: true, checked_at: new Date().toISOString() } },
      });
    }

    const resolved = await resolveExecutor(
      { enabled: true, nodeId: policyNodeId },
      { toolMode: 'all', sandboxMode: 'sandbox' },
    );

    assert.equal(resolved?.nodeId, sandboxNodeId);
    assert.equal(resolved?.decision.placementTier, 'warm');
    assert.deepEqual(resolved?.decision.requiredCapabilities, ['sandbox', 'shell', 'workspace_write']);
    assert.deepEqual(resolved?.decision.skipped[0], {
      id: policyNodeId,
      reason: 'capability:sandbox_missing',
      details: { missingCapabilities: ['sandbox'] },
    });
  } finally {
    await getDb().query('DELETE FROM executor_nodes WHERE node_id = ANY($1)', [[policyNodeId, sandboxNodeId]]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('configured executor URLs are marked as degraded placement', async () => {
  const resolved = await resolveExecutor(
    { enabled: true, nodeUrls: ['http://127.0.0.1:18093'] },
    { toolMode: 'read-only', sandboxMode: 'readonly' },
  );

  assert.equal(resolved?.decision.placementTier, 'degraded');
  assert.deepEqual(resolved?.decision.requiredCapabilities, ['workspace_read']);
});

test('resolveExecutor rejects warning-level memory pressure for heavy work', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const nodeId = `pressured-heavy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await upsertExecutorNode({
      nodeId,
      nodeKind: 'executor',
      status: 'online',
      baseUrl: 'http://127.0.0.1:18094',
      connectModes: ['agent_http'],
      capacity: { memoryTotalMb: 1000, memoryAvailableMb: 80 },
      capabilities: { run_agent: true, workspace_write: true, heavy_task_safe: true },
      verified: { agent_http: { ok: true, checked_at: new Date().toISOString() } },
    });

    await assert.rejects(
      resolveExecutor({ enabled: true, nodeId, requiresBuild: true }, { toolMode: 'project-write' }),
      (error: unknown) => {
        assert.ok(error instanceof _ExecutorSelectionError);
        assert.equal(error.decision.skipped.find(item => item.id === nodeId)?.reason, 'resource:memory_pressure');
        return true;
      },
    );
  } finally {
    await getDb().query('DELETE FROM executor_nodes WHERE node_id = $1', [nodeId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('scheduled task persists no-match executor decision evidence', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const nodeId = `critical-egress-${suffix}`;
  const taskRunId = `task-no-match-${suffix}`;
  const sessionId = `session-no-match-${suffix}`;
  try {
    await upsertExecutorNode({
      nodeId,
      nodeKind: 'executor',
      status: 'online',
      baseUrl: 'http://127.0.0.1:18095',
      connectModes: ['agent_http'],
      capacity: { memoryTotalMb: 1000, memoryAvailableMb: 40 },
      capabilities: { run_agent: true, workspace_write: true, network_egress: true },
      verified: { agent_http: { ok: true, checked_at: new Date().toISOString() } },
    });

    await assert.rejects(runScheduledAgentTask({
      prompt: 'must fail before execution',
      taskRunId,
      sessionId,
      executor: { enabled: true, nodeId, requiredCapabilities: ['network_egress'] },
    }), _ExecutorSelectionError);

    const decisions = await listSchedulerDecisions({ graphId: taskRunId, kind: 'executor_selection' });
    assert.equal(decisions[0]?.reason, 'no_executor_match');
    assert.deepEqual(decisions[0]?.selectedIds, []);
    assert.equal(decisions[0]?.skipped.find(item => item.id === nodeId)?.reason, 'resource:memory_pressure');
  } finally {
    await getDb().query('DELETE FROM scheduler_decisions WHERE graph_id = $1', [taskRunId]).catch(() => undefined);
    await getDb().query('DELETE FROM executor_nodes WHERE node_id = $1', [nodeId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
