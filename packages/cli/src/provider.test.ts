import assert from 'node:assert/strict';
import test from 'node:test';

import { providerCommand } from './provider.js';

test('provider policy list uses global access credentials without operator escalation', async () => {
  const request = await captureProviderRequest(
    () => providerCommand(['--auth-token', 'access-token'], ['policy', 'list', '--json']),
    { count: 0, decisions: [] },
  );

  assert.equal(request.method, 'GET');
  assert.equal(request.headers.get('x-los-auth-token'), 'access-token');
  assert.equal(request.headers.get('x-los-operator-token'), null);
});

test('provider policy enforce sends global access and operator credentials', async () => {
  const request = await captureProviderRequest(
    () => providerCommand(
      ['--auth-token', 'access-token', '--operator-token', 'operator-token'],
      ['policy', 'enforce', 'decision-1', '--json'],
    ),
    { decision: { id: 'decision-1', status: 'enforced' } },
  );

  assert.equal(request.method, 'POST');
  assert.equal(request.headers.get('x-los-auth-token'), 'access-token');
  assert.equal(request.headers.get('x-los-operator-token'), 'operator-token');
  assert.deepEqual(await request.json(), { id: 'decision-1', actor: 'cli' });
});

test('provider list renders the current onboarding compat evidence shape', async () => {
  const output = await captureProviderOutput(() => providerCommand([], ['list']), {
    providers: [{
      name: 'deepseek',
      available: true,
      source: 'env',
      defaultModel: 'deepseek-v4-flash',
      readiness: { ready: true, promotionState: 'verified_advisory' },
      compatEvidence: {
        count: 1,
        latest: {
          id: 'provider-compat-deepseek',
          probeId: 'read-context',
          taskRunId: 'task-1',
          totalTokens: 123,
          passed: true,
        },
      },
    }],
  });

  assert.match(output, /evidence provider-compat-deepseek probe=read-context task=task-1 tokens=123/);
  assert.doesNotMatch(output, /evidence none/);
});

async function captureProviderRequest(run: () => Promise<void>, responseBody: unknown): Promise<Request> {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  let captured: Request | undefined;
  console.log = () => {};
  globalThis.fetch = async (input, init) => {
    captured = new Request(input, init);
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
  }
}

async function captureProviderOutput(run: () => Promise<void>, responseBody: unknown): Promise<string> {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  globalThis.fetch = async () => new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    await run();
    return lines.join('\n');
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
}
