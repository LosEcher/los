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
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE id = $1', [taskRunId]).catch(() => undefined);
    await getDb().query('DELETE FROM executor_nodes WHERE node_id = $1', [nodeId]).catch(() => undefined);
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
  return new Promise(resolve => server.close(() => resolve()));
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

function sendJson(res: ServerResponse, body: unknown): void {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}
