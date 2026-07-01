import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { closeDb, getDb, initDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import { upsertExecutorNode } from './executor-nodes.js';
import {
  createAgentTask,
  linkAgentTaskDependency,
  listAgentTaskAttempts,
} from './agent-task-graph.js';
import { readAgentTaskGraph } from './agent-task-graph-read-model.js';
import { createRunSpec, loadRunSpec } from './run-specs.js';
import { recordProviderCompatEvidence } from './provider-compat-evidence.js';
import { listSchedulerDecisions } from './scheduler-decision-ledger.js';
import { listSessionEvents } from './session-events.js';
import { loadToolCallState } from './tool-call-states.js';
import { persistScheduledToolCallState, runAgentTaskGraphSerial, runScheduledAgentTask } from './scheduler.js';

test('scheduler uses a verified registry executor when nodeUrls is empty', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const nodeId = `test-scheduler-executor-${suffix}`;
  const taskRunId = `task-${suffix}`;
  const sessionId = `session-${suffix}`;
  const requests: Array<Record<string, unknown>> = [];

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/tasks/run-agent') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    requests.push(JSON.parse(await readRequestBody(req)));
    sendJson(res, {
      events: [],
      deltas: [],
      result: {
        text: 'executor ok',
        turns: [],
        loopCount: 0,
        totalTokens: { prompt: 0, completion: 0 },
        messages: [],
      },
    });
  });

  try {
    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await upsertExecutorNode({
      nodeId,
      nodeKind: 'executor',
      status: 'online',
      baseUrl,
      connectModes: ['agent_http'],
      connectConfig: {
        agent_http: { baseUrl },
      },
      capabilities: { run_agent: true },
      verified: {
        agent_http: { ok: true, checked_at: new Date().toISOString() },
      },
    });

    const result = await runScheduledAgentTask({
      prompt: 'use registry executor',
      taskRunId,
      sessionId,
      workspaceRoot: process.cwd(),
      executor: {
        enabled: true,
        nodeUrls: [],
        nodeId,
      },
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.taskRun.nodeId, nodeId);
    assert.equal(result.result.text, 'executor ok');
    assert.equal(requests[0]?.nodeId, nodeId);

    const decisions = await listSchedulerDecisions({ graphId: taskRunId, kind: 'executor_selection' });
    assert.equal(decisions[0]?.reason, 'executor_registry');
    assert.deepEqual(decisions[0]?.selectedIds, [nodeId]);
  } finally {
    await getDb().query('DELETE FROM scheduler_decisions WHERE graph_id = $1', [taskRunId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE id = $1', [taskRunId]).catch(() => undefined);
    await getDb().query('DELETE FROM executor_nodes WHERE node_id = $1', [nodeId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
    await closeServer(server);
  }
});

test('scheduler phase gate reads current run spec contract instead of stale task metadata', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const taskRunId = `task-current-contract-${suffix}`;
  const sessionId = `session-current-contract-${suffix}`;
  const runSpecId = `run-current-contract-${suffix}`;
  const nodeId = `test-current-contract-executor-${suffix}`;
  const requests: Array<{ config?: { runContractMetadata?: { runContract?: { phase?: unknown; mode?: unknown } } } }> = [];

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/tasks/run-agent') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    requests.push(JSON.parse(await readRequestBody(req)));
    sendJson(res, {
      events: [],
      deltas: [],
      result: {
        text: 'executor ok',
        turns: [],
        loopCount: 0,
        totalTokens: { prompt: 0, completion: 0 },
        messages: [],
      },
    });
  });

  try {
    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'current contract',
      systemPrompt: undefined,
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      maxLoops: 1,
      runContract: { mode: 'execution', phase: 'plan_approved' },
    });

    const result = await runScheduledAgentTask({
      prompt: 'use current run spec contract',
      taskRunId,
      runSpecId,
      sessionId,
      workspaceRoot: process.cwd(),
      runContract: { mode: 'execution', phase: 'planning' },
      executor: {
        enabled: true,
        nodeUrls: [baseUrl],
        nodeId,
      },
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.result.text, 'executor ok');
    assert.equal(requests[0]?.config?.runContractMetadata?.runContract?.mode, 'execution');
    assert.equal(requests[0]?.config?.runContractMetadata?.runContract?.phase, 'plan_approved');
  } finally {
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE id = $1', [taskRunId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
    await closeServer(server);
  }
});

test('scheduler persists tool call state transitions', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-tool-state-${suffix}`;
  const taskRunId = `task-tool-state-${suffix}`;
  const runSpecId = `run-tool-state-${suffix}`;
  const callId = `call-tool-state-${suffix}`;

  try {
    await persistScheduledToolCallState({
      sessionId,
      taskRunId,
      runSpecId,
      transition: {
        callId,
        toolName: 'read_file',
        state: 'requested',
        turn: 1,
        input: { path: 'README.md' },
        maxAttempts: 2,
        idempotent: true,
        retryPolicy: { maxAttempts: 2 },
      },
    });
    await persistScheduledToolCallState({
      sessionId,
      taskRunId,
      runSpecId,
      transition: {
        callId,
        toolName: 'read_file',
        state: 'running',
        turn: 1,
      },
    });
    await persistScheduledToolCallState({
      sessionId,
      taskRunId,
      runSpecId,
      transition: {
        callId,
        toolName: 'read_file',
        state: 'succeeded',
        turn: 1,
        outputSummary: 'ok',
        durationMs: 12,
        attempt: 1,
      },
    });

    const loaded = await loadToolCallState(callId, sessionId);
    assert.equal(loaded?.runSpecId, runSpecId);
    assert.equal(loaded?.taskRunId, taskRunId);
    assert.equal(loaded?.state, 'succeeded');
    assert.equal(loaded?.toolName, 'read_file');
    assert.deepEqual(loaded?.inputJson, { path: 'README.md' });
    assert.equal(loaded?.outputSummary, 'ok');
    assert.equal(loaded?.durationMs, 12);
    assert.equal(loaded?.maxAttempts, 2);
    assert.equal(loaded?.idempotent, true);
  } finally {
    await getDb().query('DELETE FROM tool_call_states WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('scheduler persists tool call states streamed from executor NDJSON', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const nodeId = `test-ndjson-executor-${suffix}`;
  const taskRunId = `task-ndjson-tool-state-${suffix}`;
  const sessionId = `session-ndjson-tool-state-${suffix}`;
  const runSpecId = `run-ndjson-tool-state-${suffix}`;
  const callId = `call-ndjson-tool-state-${suffix}`;

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/tasks/run-agent') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    await readRequestBody(req);
    res.setHeader('content-type', 'application/x-ndjson');
    res.write(JSON.stringify({
      type: 'tool_call_state',
      transition: {
        callId,
        toolName: 'read_file',
        state: 'requested',
        turn: 1,
        input: { path: 'README.md' },
        maxAttempts: 1,
        idempotent: true,
      },
    }) + '\n');
    res.write(JSON.stringify({
      type: 'tool_call_state',
      transition: {
        callId,
        toolName: 'read_file',
        state: 'succeeded',
        turn: 1,
        outputSummary: 'executor ok',
        durationMs: 7,
        attempt: 1,
      },
    }) + '\n');
    res.end(JSON.stringify({
      type: 'result',
      result: {
        text: 'executor ok',
        turns: [],
        loopCount: 0,
        totalTokens: { prompt: 0, completion: 0 },
        messages: [],
      },
    }) + '\n');
  });

  try {
    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const result = await runScheduledAgentTask({
      prompt: 'use ndjson executor',
      taskRunId,
      runSpecId,
      sessionId,
      workspaceRoot: process.cwd(),
      executor: {
        enabled: true,
        nodeUrls: [baseUrl],
        nodeId,
      },
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.result.text, 'executor ok');

    const loaded = await loadToolCallState(callId, sessionId);
    assert.equal(loaded?.runSpecId, runSpecId);
    assert.equal(loaded?.taskRunId, taskRunId);
    assert.equal(loaded?.state, 'succeeded');
    assert.equal(loaded?.toolName, 'read_file');
    assert.deepEqual(loaded?.inputJson, { path: 'README.md' });
    assert.equal(loaded?.outputSummary, 'executor ok');
    assert.equal(loaded?.durationMs, 7);
  } finally {
    await getDb().query('DELETE FROM tool_call_states WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE id = $1', [taskRunId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
    await closeServer(server);
  }
});

test('scheduler runs a single agent task graph with conservative serial claims', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const graphId = `graph-scheduler-serial-${suffix}`;
  const sessionId = `session-graph-scheduler-serial-${suffix}`;
  const nodeId = `test-graph-serial-executor-${suffix}`;
  const requests: Array<{ prompt?: unknown }> = [];

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/tasks/run-agent') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    const body = JSON.parse(await readRequestBody(req)) as { prompt?: unknown };
    requests.push(body);
    sendJson(res, {
      events: [],
      deltas: [],
      result: {
        text: `completed ${String(body.prompt ?? '')}`,
        turns: [],
        loopCount: 0,
        totalTokens: { prompt: 0, completion: 0 },
        messages: [],
      },
    });
  });

  try {
    await createAgentTask({
      id: `${graphId}-plan`,
      graphId,
      sessionId,
      role: 'planner',
      title: 'Plan graph work',
      prompt: 'plan prompt',
      priority: 10,
    });
    await createAgentTask({
      id: `${graphId}-exec`,
      graphId,
      sessionId,
      role: 'executor',
      title: 'Execute graph work',
      prompt: 'exec prompt',
      priority: 20,
    });
    await linkAgentTaskDependency({
      graphId,
      taskId: `${graphId}-exec`,
      dependsOnTaskId: `${graphId}-plan`,
    });

    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const result = await runAgentTaskGraphSerial({
      graphId,
      sessionId,
      workspaceRoot: process.cwd(),
      executor: {
        enabled: true,
        nodeUrls: [baseUrl],
        nodeId,
      },
    });

    assert.deepEqual(result.executedTasks.map(task => task.taskId), [`${graphId}-plan`, `${graphId}-exec`]);
    assert.deepEqual(result.executedTasks.map(task => task.status), ['succeeded', 'succeeded']);
    assert.equal(result.completion.status, 'succeeded');
    assert.deepEqual(requests.map(request => request.prompt), ['plan prompt', 'exec prompt']);

    const graph = await readAgentTaskGraph(graphId);
    assert.deepEqual(graph.tasks.map(task => task.status), ['succeeded', 'succeeded']);
    assert.equal((await listAgentTaskAttempts(`${graphId}-plan`)).length, 1);
    assert.equal((await listAgentTaskAttempts(`${graphId}-exec`)).length, 1);
  } finally {
    await getDb().query('DELETE FROM tool_call_states WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_attempts WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_edges WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM agent_tasks WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
    await closeServer(server);
  }
});

test('scheduler runs independent graph tasks in parallel without editable surface conflicts', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const graphId = `graph-scheduler-parallel-${suffix}`;
  const sessionId = `session-graph-scheduler-parallel-${suffix}`;
  const nodeId = `test-graph-parallel-executor-${suffix}`;
  const requests: Array<{ prompt?: unknown }> = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/tasks/run-agent') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    const body = JSON.parse(await readRequestBody(req)) as { prompt?: unknown };
    requests.push(body);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await delay(40);
    inFlight -= 1;
    sendJson(res, {
      events: [],
      deltas: [],
      result: {
        text: `completed ${String(body.prompt ?? '')}`,
        turns: [],
        loopCount: 0,
        totalTokens: { prompt: 0, completion: 0 },
        messages: [],
      },
    });
  });

  try {
    await createAgentTask({
      id: `${graphId}-agent-a`,
      graphId,
      sessionId,
      role: 'executor',
      title: 'Implement agent A',
      prompt: 'agent a prompt',
      priority: 10,
      metadata: { runContract: { editableSurfaces: ['packages/agent'] } },
    });
    await createAgentTask({
      id: `${graphId}-agent-b`,
      graphId,
      sessionId,
      role: 'executor',
      title: 'Implement agent B',
      prompt: 'agent b prompt',
      priority: 20,
      metadata: { runContract: { editableSurfaces: ['packages/agent/src/scheduler.ts'] } },
    });
    await createAgentTask({
      id: `${graphId}-web`,
      graphId,
      sessionId,
      role: 'executor',
      title: 'Implement web',
      prompt: 'web prompt',
      priority: 30,
      metadata: { runContract: { editableSurfaces: ['packages/web'] } },
    });

    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const result = await runAgentTaskGraphSerial({
      graphId,
      sessionId,
      workspaceRoot: process.cwd(),
      maxParallelTasks: 2,
      editableSurfaceMode: 'require-declared',
      executor: {
        enabled: true,
        nodeUrls: [baseUrl],
        nodeId,
      },
    });

    assert.deepEqual(result.executedTasks.map(task => task.taskId), [
      `${graphId}-agent-a`,
      `${graphId}-web`,
      `${graphId}-agent-b`,
    ]);
    assert.deepEqual(result.executedTasks.map(task => task.status), ['succeeded', 'succeeded', 'succeeded']);
    assert.equal(result.completion.status, 'succeeded');
    assert.equal(maxInFlight, 2);
    assert.deepEqual(
      requests.map(request => request.prompt).sort(),
      ['agent a prompt', 'agent b prompt', 'web prompt'],
    );

    const graph = await readAgentTaskGraph(graphId);
    assert.deepEqual(graph.tasks.map(task => task.status), ['succeeded', 'succeeded', 'succeeded']);

    const claimDecisions = await listSchedulerDecisions({ graphId, kind: 'claim' });
    assert.equal(claimDecisions[0]?.reason, 'ready_tasks_claimed');
    assert.deepEqual(claimDecisions[0]?.selectedIds.sort(), [`${graphId}-agent-a`, `${graphId}-web`].sort());
    assert.equal(claimDecisions[0]?.skipped[0]?.id, `${graphId}-agent-b`);
    assert.equal(claimDecisions[0]?.skipped[0]?.reason, 'editable_surface_conflict');
  } finally {
    await getDb().query('DELETE FROM scheduler_decisions WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM tool_call_states WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_attempts WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_edges WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM agent_tasks WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
    await closeServer(server);
  }
});

test('scheduler selects graph task provider and model from compatibility evidence', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const graphId = `graph-provider-selection-${suffix}`;
  const sessionId = `session-provider-selection-${suffix}`;
  const nodeId = `test-provider-selection-executor-${suffix}`;
  const unverifiedProvider = `unverified-provider-${suffix}`;
  const verifiedProvider = `verified-provider-${suffix}`;
  const evidenceId = `provider-selection-evidence-${suffix}`;
  const requests: Array<{ config?: { provider?: unknown; model?: unknown } }> = [];

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/tasks/run-agent') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    const body = JSON.parse(await readRequestBody(req)) as { config?: { provider?: unknown; model?: unknown } };
    requests.push(body);
    sendJson(res, {
      events: [],
      deltas: [],
      result: {
        text: 'provider-selected task succeeded',
        turns: [],
        loopCount: 0,
        totalTokens: { prompt: 0, completion: 0 },
        messages: [],
      },
    });
  });

  try {
    await recordProviderCompatEvidence({
      id: evidenceId,
      provider: verifiedProvider,
      model: 'model-b',
      probeId: 'read-context',
      decision: 'verified_advisory',
      passed: true,
      totalTokens: 12,
      summary: { selectedBy: 'graph task provider target test' },
    });
    await createAgentTask({
      id: `${graphId}-exec`,
      graphId,
      sessionId,
      role: 'executor',
      title: 'Execute with task-level provider target',
      prompt: 'provider selection prompt',
      metadata: {
        providerModelTargets: [
          `${unverifiedProvider}:model-a`,
          { provider: verifiedProvider, model: 'model-b' },
        ],
        requireProviderCompat: true,
      },
    });

    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const result = await runAgentTaskGraphSerial({
      graphId,
      sessionId,
      provider: 'scheduler-default-provider',
      model: 'scheduler-default-model',
      workspaceRoot: process.cwd(),
      executor: {
        enabled: true,
        nodeUrls: [baseUrl],
        nodeId,
      },
    });

    assert.equal(result.completion.status, 'succeeded');
    assert.equal(requests[0]?.config?.provider, verifiedProvider);
    assert.equal(requests[0]?.config?.model, 'model-b');

    const attempts = await listAgentTaskAttempts(`${graphId}-exec`);
    assert.equal(attempts[0]?.provider, verifiedProvider);
    assert.equal(attempts[0]?.model, 'model-b');

    const graph = await readAgentTaskGraph(graphId);
    const selection = graph.tasks[0]?.metadata.providerModelSelection as Record<string, unknown> | undefined;
    assert.equal(selection?.source, 'provider_compat_evidence');
    assert.equal(selection?.evidenceId, evidenceId);
    assert.equal(selection?.targetLabel, `${verifiedProvider}:model-b`);

    const decisions = await listSchedulerDecisions({ graphId, taskId: `${graphId}-exec`, kind: 'provider_selection' });
    assert.equal(decisions[0]?.reason, 'provider_compat_evidence');
    assert.equal(decisions[0]?.provider, verifiedProvider);
    assert.equal(decisions[0]?.model, 'model-b');
    assert.equal(decisions[0]?.metadata.evidenceId, evidenceId);
    assert.deepEqual(decisions[0]?.skipped, [{ id: `${unverifiedProvider}:model-a`, reason: 'provider_capability_mismatch', details: {} }]);
  } finally {
    await getDb().query('DELETE FROM scheduler_decisions WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM provider_compat_evidence WHERE provider IN ($1, $2)', [unverifiedProvider, verifiedProvider]).catch(() => undefined);
    await getDb().query('DELETE FROM tool_call_states WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_attempts WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_edges WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM agent_tasks WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
    await closeServer(server);
  }
});

test('scheduler blocks graph task provider selection when required compatibility evidence is missing', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const graphId = `graph-provider-selection-missing-${suffix}`;
  const sessionId = `session-provider-selection-missing-${suffix}`;
  const provider = `missing-evidence-provider-${suffix}`;

  try {
    await createAgentTask({
      id: `${graphId}-exec`,
      graphId,
      sessionId,
      role: 'executor',
      title: 'Execute without required provider evidence',
      prompt: 'provider selection should fail',
      metadata: {
        providerModelTargets: [{ provider, model: 'model-missing' }],
        requireProviderCompat: true,
      },
    });

    const result = await runAgentTaskGraphSerial({
      graphId,
      sessionId,
      provider: 'scheduler-default-provider',
      model: 'scheduler-default-model',
      workspaceRoot: process.cwd(),
    });

    assert.deepEqual(result.executedTasks.map(task => task.status), ['failed']);
    assert.equal(result.completion.status, 'failed');

    const attempts = await listAgentTaskAttempts(`${graphId}-exec`);
    assert.equal(attempts[0]?.provider, undefined);
    assert.match(attempts[0]?.error ?? '', /requires passing provider compatibility evidence/);

    const graph = await readAgentTaskGraph(graphId);
    assert.equal(graph.tasks[0]?.status, 'failed');
    assert.match(String(graph.tasks[0]?.metadata.error ?? ''), /requires passing provider compatibility evidence/);
  } finally {
    await getDb().query('DELETE FROM scheduler_decisions WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM provider_compat_evidence WHERE provider = $1', [provider]).catch(() => undefined);
    await getDb().query('DELETE FROM tool_call_states WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_attempts WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_edges WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM agent_tasks WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('scheduler blocks graph run completion when tool recovery is required', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const graphId = `graph-recovery-required-${suffix}`;
  const sessionId = `session-recovery-required-${suffix}`;
  const runSpecId = `run-recovery-required-${suffix}`;
  const nodeId = `test-recovery-required-executor-${suffix}`;
  const callId = `call-recovery-required-${suffix}`;

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/tasks/run-agent') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    await readRequestBody(req);
    res.setHeader('content-type', 'application/x-ndjson');
    res.write(JSON.stringify({
      type: 'tool_call_state',
      transition: {
        callId,
        toolName: 'read_file',
        state: 'requested',
        turn: 1,
        input: { path: 'missing.md' },
        maxAttempts: 2,
        idempotent: true,
      },
    }) + '\n');
    res.write(JSON.stringify({
      type: 'tool_call_state',
      transition: {
        callId,
        toolName: 'read_file',
        state: 'failed',
        turn: 1,
        attempt: 1,
        error: 'missing.md not found',
      },
    }) + '\n');
    res.end(JSON.stringify({
      type: 'result',
      result: {
        text: 'task returned despite failed tool state',
        turns: [],
        loopCount: 1,
        totalTokens: { prompt: 0, completion: 0 },
        messages: [],
      },
    }) + '\n');
  });

  try {
    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'run graph with failed tool state',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      maxLoops: 1,
    });
    await createAgentTask({
      id: `${graphId}-exec`,
      graphId,
      runSpecId,
      sessionId,
      role: 'executor',
      title: 'Execute with failed tool state',
      prompt: 'exec prompt',
    });

    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const result = await runAgentTaskGraphSerial({
      graphId,
      runSpecId,
      sessionId,
      workspaceRoot: process.cwd(),
      executor: {
        enabled: true,
        nodeUrls: [baseUrl],
        nodeId,
      },
    });

    assert.equal(result.completion.status, 'succeeded');
    assert.equal(result.recovery?.status, 'action_required');
    assert.equal(result.recovery?.recommendation, 'retry');
    assert.deepEqual(result.recovery?.retryToolCallIds, [callId]);
    assert.equal((await loadRunSpec(runSpecId))?.status, 'blocked');

    const events = await listSessionEvents(sessionId, 100);
    const recoveryEvent = events.find(event => event.type === 'run.recovery_required');
    assert.equal(recoveryEvent?.payload.runSpecId, runSpecId);
    assert.equal(recoveryEvent?.payload.graphId, graphId);
    assert.equal(recoveryEvent?.payload.recommendation, 'retry');
    assert.deepEqual(recoveryEvent?.payload.retryToolCallIds, [callId]);
  } finally {
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM tool_call_states WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_attempts WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_edges WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM agent_tasks WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
    await closeServer(server);
  }
});

test('scheduler queues retry follow-up attempts for recoverable tool failures', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const graphId = `graph-recovery-followup-${suffix}`;
  const sessionId = `session-recovery-followup-${suffix}`;
  const runSpecId = `run-recovery-followup-${suffix}`;
  const nodeId = `test-recovery-followup-executor-${suffix}`;
  const callId = `call-recovery-followup-${suffix}`;
  let requestCount = 0;

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/tasks/run-agent') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    requestCount += 1;
    await readRequestBody(req);
    res.setHeader('content-type', 'application/x-ndjson');
    if (requestCount === 1) {
      res.write(JSON.stringify({
        type: 'tool_call_state',
        transition: {
          callId,
          toolName: 'read_file',
          state: 'requested',
          turn: 1,
          input: { path: 'missing-once.md' },
          maxAttempts: 2,
          idempotent: true,
        },
      }) + '\n');
      res.write(JSON.stringify({
        type: 'tool_call_state',
        transition: {
          callId,
          toolName: 'read_file',
          state: 'failed',
          turn: 1,
          attempt: 1,
          error: 'temporary missing file',
        },
      }) + '\n');
    }
    res.end(JSON.stringify({
      type: 'result',
      result: {
        text: requestCount === 1 ? 'first task returned with failed tool state' : 'second task recovered',
        turns: [],
        loopCount: 1,
        totalTokens: { prompt: 0, completion: 0 },
        messages: [],
      },
    }) + '\n');
  });

  try {
    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'run graph with retryable failed tool state',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      maxLoops: 1,
    });
    await createAgentTask({
      id: `${graphId}-exec`,
      graphId,
      runSpecId,
      sessionId,
      role: 'executor',
      title: 'Execute with retryable failed tool state',
      prompt: 'exec prompt',
      maxAttempts: 2,
    });

    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const result = await runAgentTaskGraphSerial({
      graphId,
      runSpecId,
      sessionId,
      workspaceRoot: process.cwd(),
      executor: {
        enabled: true,
        nodeUrls: [baseUrl],
        nodeId,
      },
    });

    assert.equal(requestCount, 2);
    assert.deepEqual(result.executedTasks.map(task => task.status), ['failed', 'succeeded']);
    assert.equal(result.executedTasks[0]?.recoveryFollowUpQueued, true);
    assert.equal(result.completion.status, 'succeeded');
    assert.equal((await loadRunSpec(runSpecId))?.status, 'succeeded');

    const attempts = await listAgentTaskAttempts(`${graphId}-exec`);
    assert.deepEqual(attempts.map(attempt => attempt.status), ['failed', 'succeeded']);
    assert.deepEqual(attempts[0]?.toolCallStateIds, [callId]);
    assert.match(attempts[0]?.error ?? '', /recovery retry queued follow-up attempt 2\/2/);

    const toolState = await loadToolCallState(callId, sessionId);
    assert.equal(toolState?.state, 'retrying');
    assert.equal(toolState?.attempt, 2);
    assert.equal(toolState?.completedAt, undefined);

    const events = await listSessionEvents(sessionId, 100);
    const followUp = events.find(event => event.type === 'task.recovery_followup_queued');
    assert.equal(followUp?.payload.taskId, `${graphId}-exec`);
    assert.equal(followUp?.payload.recommendation, 'retry');
    assert.deepEqual(followUp?.payload.retryToolCallIds, [callId]);
  } finally {
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM tool_call_states WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_attempts WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_edges WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM agent_tasks WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
    await closeServer(server);
  }
});

test('scheduler blocks run spec completion when verifier is required but missing', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const graphId = `graph-verifier-gate-${suffix}`;
  const sessionId = `session-verifier-gate-${suffix}`;
  const runSpecId = `run-verifier-gate-${suffix}`;
  const nodeId = `test-verifier-gate-executor-${suffix}`;

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/tasks/run-agent') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    await readRequestBody(req);
    sendJson(res, {
      events: [],
      deltas: [],
      result: {
        text: 'executor task succeeded',
        turns: [],
        loopCount: 0,
        totalTokens: { prompt: 0, completion: 0 },
        messages: [],
      },
    });
  });

  try {
    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'run graph with required verifier',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      maxLoops: 1,
    });
    await createAgentTask({
      id: `${graphId}-exec`,
      graphId,
      runSpecId,
      sessionId,
      role: 'executor',
      title: 'Execute without verifier',
      prompt: 'exec prompt',
    });

    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const result = await runAgentTaskGraphSerial({
      graphId,
      runSpecId,
      sessionId,
      requireVerifier: true,
      workspaceRoot: process.cwd(),
      executor: {
        enabled: true,
        nodeUrls: [baseUrl],
        nodeId,
      },
    });

    assert.equal(result.completion.status, 'blocked');
    assert.equal(result.completion.reason, 'succeeded verifier task is required for completion');
    assert.equal((await loadRunSpec(runSpecId))?.status, 'blocked');

    const events = await listSessionEvents(sessionId, 100);
    const blocked = events.find(event => event.type === 'run.blocked');
    assert.equal(blocked?.payload.runSpecId, runSpecId);
    assert.equal(blocked?.payload.graphId, graphId);
    assert.equal(blocked?.payload.requireVerifier, true);
  } finally {
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM tool_call_states WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_attempts WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_edges WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM agent_tasks WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
    await closeServer(server);
  }
});

test('scheduler runs verifier graph tasks through verification records', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const graphId = `graph-verifier-runner-${suffix}`;
  const sessionId = `session-verifier-runner-${suffix}`;
  const runSpecId = `run-verifier-runner-${suffix}`;
  const nodeId = `test-verifier-runner-executor-${suffix}`;
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('dag verify ok')")}`;

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/tasks/run-agent') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    await readRequestBody(req);
    sendJson(res, {
      events: [],
      deltas: [],
      result: {
        text: 'executor task succeeded before verifier',
        turns: [],
        loopCount: 0,
        totalTokens: { prompt: 0, completion: 0 },
        messages: [],
      },
    });
  });

  try {
    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'run graph with verifier task',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      maxLoops: 1,
      runContract: {
        mode: 'closeout',
        requiredChecks: [command],
      },
    });
    await createAgentTask({
      id: `${graphId}-exec`,
      graphId,
      runSpecId,
      sessionId,
      role: 'executor',
      title: 'Execute before verifier',
      prompt: 'exec prompt',
      priority: 10,
    });
    await createAgentTask({
      id: `${graphId}-verify`,
      graphId,
      runSpecId,
      sessionId,
      role: 'verifier',
      title: 'Verify graph result',
      priority: 20,
    });
    await linkAgentTaskDependency({
      graphId,
      taskId: `${graphId}-verify`,
      dependsOnTaskId: `${graphId}-exec`,
    });

    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const result = await runAgentTaskGraphSerial({
      graphId,
      runSpecId,
      sessionId,
      requireVerifier: true,
      workspaceRoot: process.cwd(),
      executor: {
        enabled: true,
        nodeUrls: [baseUrl],
        nodeId,
      },
      timeoutMs: 5_000,
    });

    assert.deepEqual(result.executedTasks.map(task => task.taskId), [`${graphId}-exec`, `${graphId}-verify`]);
    assert.deepEqual(result.executedTasks.map(task => task.status), ['succeeded', 'succeeded']);
    assert.equal(result.executedTasks[1]?.verificationRecordId, `verification-${runSpecId}-1`);
    assert.equal(result.completion.status, 'succeeded');
    assert.equal(result.completion.canComplete, true);
    assert.equal((await loadRunSpec(runSpecId))?.status, 'succeeded');

    const attempts = await listAgentTaskAttempts(`${graphId}-verify`);
    assert.equal(attempts[0]?.status, 'succeeded');
    assert.equal(attempts[0]?.verificationRecordId, `verification-${runSpecId}-1`);

    const events = await listSessionEvents(sessionId, 100);
    assert.ok(events.some(event => event.type === 'verification.succeeded'));
  } finally {
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM tool_call_states WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_attempts WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_edges WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM agent_tasks WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
    await closeServer(server);
  }
});

test('scheduler blocks graph completion when verifier graph task fails checks', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const graphId = `graph-verifier-failure-${suffix}`;
  const sessionId = `session-verifier-failure-${suffix}`;
  const runSpecId = `run-verifier-failure-${suffix}`;
  const nodeId = `test-verifier-failure-executor-${suffix}`;
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.error('dag verify failed'); process.exit(7)")}`;

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/tasks/run-agent') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    await readRequestBody(req);
    sendJson(res, {
      events: [],
      deltas: [],
      result: {
        text: 'executor task succeeded before failing verifier',
        turns: [],
        loopCount: 0,
        totalTokens: { prompt: 0, completion: 0 },
        messages: [],
      },
    });
  });

  try {
    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'run graph with failing verifier task',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      maxLoops: 1,
      runContract: {
        mode: 'closeout',
        requiredChecks: [command],
      },
    });
    await createAgentTask({
      id: `${graphId}-exec`,
      graphId,
      runSpecId,
      sessionId,
      role: 'executor',
      title: 'Execute before verifier failure',
      prompt: 'exec prompt',
      priority: 10,
    });
    await createAgentTask({
      id: `${graphId}-verify`,
      graphId,
      runSpecId,
      sessionId,
      role: 'verifier',
      title: 'Verify graph result fails',
      priority: 20,
    });
    await linkAgentTaskDependency({
      graphId,
      taskId: `${graphId}-verify`,
      dependsOnTaskId: `${graphId}-exec`,
    });

    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const result = await runAgentTaskGraphSerial({
      graphId,
      runSpecId,
      sessionId,
      requireVerifier: true,
      workspaceRoot: process.cwd(),
      executor: {
        enabled: true,
        nodeUrls: [baseUrl],
        nodeId,
      },
      timeoutMs: 5_000,
    });

    assert.deepEqual(result.executedTasks.map(task => task.status), ['succeeded', 'failed']);
    assert.equal(result.executedTasks[1]?.verificationRecordId, `verification-${runSpecId}-1`);
    assert.equal(result.completion.status, 'blocked');
    assert.equal(result.completion.blockReason, 'verifier_required');
    assert.deepEqual(result.completion.failedVerifierTaskIds, [`${graphId}-verify`]);
    assert.equal((await loadRunSpec(runSpecId))?.status, 'blocked');

    const attempts = await listAgentTaskAttempts(`${graphId}-verify`);
    assert.equal(attempts[0]?.status, 'failed');
    assert.equal(attempts[0]?.verificationRecordId, `verification-${runSpecId}-1`);
    assert.match(attempts[0]?.outputSummary ?? '', /verification blocked/);

    const events = await listSessionEvents(sessionId, 100);
    assert.ok(events.some(event => event.type === 'verification.failed'));
  } finally {
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM tool_call_states WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_attempts WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_edges WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM agent_tasks WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
    await closeServer(server);
  }
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  // Drop lingering keep-alive connections before close(). Without this,
  // server.close() waits for keep-alive sockets to time out and the test
  // runner never exits — an intermittent 8m+ hang reproduced on both
  // ubuntu CI and macOS (last passing test: "scheduler blocks graph
  // completion when verifier graph task fails checks"). The 2s backstop
  // guarantees closeServer can never hang the runner regardless of socket
  // state. closeAllConnections is Node 18.2+.
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    try {
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    } catch {
      // ignore — close() below still drains
    }
    server.close(() => finish());
    setTimeout(finish, 2000);
  });
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sendJson(res: ServerResponse, body: unknown): void {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}
