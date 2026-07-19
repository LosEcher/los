import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchCliResponse, resolveCliRequestAuth } from './cli-http.js';

test('shared CLI HTTP auth keeps operator credentials off ordinary reads', async () => {
  const request = await captureRequest(() => fetchCliResponse('http://gateway.test/items', {
    auth: { authToken: 'access-token', operatorToken: 'operator-token' },
  }));

  assert.equal(request.headers.get('x-los-auth-token'), 'access-token');
  assert.equal(request.headers.get('x-los-operator-token'), null);
});

test('shared CLI HTTP auth resolves explicit flags and sends operator credentials only for operator writes', async () => {
  const originalAuth = process.env.LOS_AUTH_TOKEN;
  const originalOperator = process.env.LOS_OPERATOR_TOKEN;
  process.env.LOS_AUTH_TOKEN = 'env-access';
  process.env.LOS_OPERATOR_TOKEN = 'env-operator';

  try {
    const auth = resolveCliRequestAuth({
      'auth-token': 'flag-access',
      'operator-token': 'flag-operator',
    });
    const request = await captureRequest(() => fetchCliResponse('http://gateway.test/items', {
      method: 'POST',
      auth,
      operatorWrite: true,
      json: true,
      body: '{}',
    }));

    assert.equal(request.headers.get('x-los-auth-token'), 'flag-access');
    assert.equal(request.headers.get('x-los-operator-token'), 'flag-operator');
    assert.equal(request.headers.get('content-type'), 'application/json');
  } finally {
    restoreEnv('LOS_AUTH_TOKEN', originalAuth);
    restoreEnv('LOS_OPERATOR_TOKEN', originalOperator);
  }
});

async function captureRequest(run: () => Promise<Response>): Promise<Request> {
  const originalFetch = globalThis.fetch;
  let captured: Request | undefined;
  globalThis.fetch = async (input, init) => {
    captured = new Request(input, init);
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await run();
    assert.ok(captured);
    return captured;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function restoreEnv(key: 'LOS_AUTH_TOKEN' | 'LOS_OPERATOR_TOKEN', value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
