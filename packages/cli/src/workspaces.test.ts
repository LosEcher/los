import assert from 'node:assert/strict';
import test from 'node:test';
import { workspacesCommand } from './workspaces.js';

test('workspace plan uses access auth without operator escalation', async () => {
  const request = await capture(() => workspacesCommand([], ['plan', 'graph-1', '--project', 'los', '--json']), {});
  assert.equal(request.url, 'http://127.0.0.1:8080/agent-graphs/graph-1/workspace-plan?projectId=los');
  assert.equal(request.method, 'GET');
  assert.equal(request.headers.get('x-los-auth-token'), 'access-token');
  assert.equal(request.headers.get('x-los-operator-token'), null);
});

test('workspace apply sends operator auth and selected tasks', async () => {
  const request = await capture(
    () => workspacesCommand([], ['apply', 'graph-1', '--project', 'los', '--tasks', 'task-a,task-b', '--json']),
    { results: [] },
  );
  assert.equal(request.url, 'http://127.0.0.1:8080/agent-graphs/graph-1/workspaces');
  assert.equal(request.headers.get('x-los-operator-token'), 'operator-token');
  assert.deepEqual(JSON.parse(request.body ?? ''), { projectId: 'los', taskIds: ['task-a', 'task-b'] });
});

test('workspace release forwards exact confirmation under operator auth', async () => {
  const request = await capture(
    () => workspacesCommand([], ['release', 'workspace-1', '--confirm', 'workspace-1', '--json']),
    { workspaceId: 'workspace-1', status: 'released' },
  );
  assert.equal(request.url, 'http://127.0.0.1:8080/managed-workspaces/workspace-1/release');
  assert.equal(request.headers.get('x-los-operator-token'), 'operator-token');
  assert.deepEqual(JSON.parse(request.body ?? ''), { confirm: 'workspace-1' });
});

async function capture(run: () => Promise<void>, responseBody: unknown) {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalAuth = process.env.LOS_AUTH_TOKEN;
  const originalOperator = process.env.LOS_OPERATOR_TOKEN;
  let captured: { url: string; method: string; headers: Headers; body?: string } | undefined;
  process.env.LOS_AUTH_TOKEN = 'access-token';
  process.env.LOS_OPERATOR_TOKEN = 'operator-token';
  console.log = () => {};
  globalThis.fetch = async (input, init) => {
    captured = { url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : undefined };
    return new Response(JSON.stringify(responseBody), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await run();
    assert.ok(captured);
    return captured;
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    restore('LOS_AUTH_TOKEN', originalAuth);
    restore('LOS_OPERATOR_TOKEN', originalOperator);
  }
}

function restore(key: 'LOS_AUTH_TOKEN' | 'LOS_OPERATOR_TOKEN', value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
