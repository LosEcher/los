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

test('HTTP task heartbeat sends the task token and keeps the lease alive', async () => {
  let seen: { url: string; token: string | undefined; body: string | undefined } | undefined;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen = {
      url: String(url),
      token: headers.get('x-los-task-token') ?? undefined,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    return new Response('{"ok":true,"taskToken":"tok-456"}', { status: 200 });
  }) as typeof fetch;

  const controller = new AbortController();
  const http = { gatewayUrl: 'http://gateway.local/', taskToken: 'tok-123', fetchImpl };
  await _renewTaskLease(
    'task-http-ok',
    'node-a',
    3,
    undefined,
    30_000,
    controller,
    http,
  );

  assert.equal(controller.signal.aborted, false);
  assert.equal(seen?.url, 'http://gateway.local/tasks/task-http-ok/heartbeat');
  assert.equal(seen?.token, 'tok-123');
  assert.deepEqual(JSON.parse(seen?.body ?? '{}'), { leaseMs: 30_000 });
  assert.equal(http.taskToken, 'tok-456');
});

test('HTTP 401 aborts with token_invalid and never falls back to DB', async () => {
  const fetchImpl = (async () => new Response('{"error":"invalid_task_token"}', { status: 401 })) as typeof fetch;
  const controller = new AbortController();
  await _renewTaskLease(
    'task-http-expired',
    'node-a',
    3,
    undefined,
    30_000,
    controller,
    { gatewayUrl: 'http://gateway.local', taskToken: 'expired', fetchImpl },
  );

  assert.equal(controller.signal.aborted, true);
  assert.match(String(controller.signal.reason), /token_invalid/);
});

test('HTTP 409 aborts with lease_lost', async () => {
  const fetchImpl = (async () => new Response('{"error":"lease_lost_or_expired"}', { status: 409 })) as typeof fetch;
  const controller = new AbortController();
  await _renewTaskLease(
    'task-http-stale',
    'node-a',
    2,
    undefined,
    30_000,
    controller,
    { gatewayUrl: 'http://gateway.local', taskToken: 'stale', fetchImpl },
  );

  assert.equal(controller.signal.aborted, true);
  assert.match(String(controller.signal.reason), /lease_lost/);
});
