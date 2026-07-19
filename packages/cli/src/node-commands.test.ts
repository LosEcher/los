import assert from 'node:assert/strict';
import test from 'node:test';

import { nodesCommand } from './node-commands.js';

test('nodes list sends the configured access token without operator escalation', async () => {
  const request = await captureNodeRequest(
    { LOS_AUTH_TOKEN: 'env-access', LOS_OPERATOR_TOKEN: 'env-operator' },
    () => nodesCommand([], ['list', '--json']),
    [],
  );

  assert.equal(request.url, 'http://127.0.0.1:8080/nodes');
  assert.equal(request.method, 'GET');
  assert.equal(request.headers.get('x-los-auth-token'), 'env-access');
  assert.equal(request.headers.get('x-los-operator-token'), null);
});

test('node operator commands prefer explicit access and operator tokens', async () => {
  const request = await captureNodeRequest(
    { LOS_AUTH_TOKEN: 'env-access', LOS_OPERATOR_TOKEN: 'env-operator' },
    () => nodesCommand(
      ['--auth-token', 'flag-access', '--operator-token', 'flag-operator'],
      ['command', 'node-1', 'drain', '--reason', 'maintenance', '--json'],
    ),
    { command: { commandId: 'command-1', nodeId: 'node-1', command: 'drain', status: 'pending' } },
  );

  assert.equal(request.url, 'http://127.0.0.1:8080/nodes/node-1/commands');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.get('x-los-auth-token'), 'flag-access');
  assert.equal(request.headers.get('x-los-operator-token'), 'flag-operator');
  assert.deepEqual(JSON.parse(request.body ?? ''), {
    command: 'drain',
    reason: 'maintenance',
  });
});

async function captureNodeRequest(
  env: { LOS_AUTH_TOKEN: string; LOS_OPERATOR_TOKEN: string },
  run: () => Promise<void>,
  responseBody: unknown,
): Promise<{ url: string; method: string; headers: Headers; body?: string }> {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalAuth = process.env.LOS_AUTH_TOKEN;
  const originalOperator = process.env.LOS_OPERATOR_TOKEN;
  let captured: { url: string; method: string; headers: Headers; body?: string } | undefined;

  process.env.LOS_AUTH_TOKEN = env.LOS_AUTH_TOKEN;
  process.env.LOS_OPERATOR_TOKEN = env.LOS_OPERATOR_TOKEN;
  console.log = () => {};
  globalThis.fetch = async (input, init) => {
    captured = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await run();
    assert.ok(captured);
    return captured;
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    restoreEnv('LOS_AUTH_TOKEN', originalAuth);
    restoreEnv('LOS_OPERATOR_TOKEN', originalOperator);
  }
}

function restoreEnv(key: 'LOS_AUTH_TOKEN' | 'LOS_OPERATOR_TOKEN', value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
