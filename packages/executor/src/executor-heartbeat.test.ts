import test from 'node:test';
import assert from 'node:assert/strict';
import { getAvailableSandbox } from '@los/agent';
import { heartbeatNode } from './executor-heartbeat.js';
import type { ExecutorRuntimeLifecycle } from './runtime-lifecycle.js';

const fakeLifecycle: ExecutorRuntimeLifecycle = {
  status: 'online',
  acceptingTasks: true,
  activeTaskCount: 0,
  startTask: () => ({ controller: new AbortController(), finish: () => undefined }),
  drain: () => undefined,
  stop: () => undefined,
} as unknown as ExecutorRuntimeLifecycle;

test('heartbeat reports a real sandbox backend when one exists, never native/none', async () => {
  const originalFetch = globalThis.fetch;
  const captured: any[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    captured.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    await heartbeatNode(
      'heartbeat-sandbox-test',
      'http://127.0.0.1:18099',
      'test-version',
      'executor',
      ['agent_http'],
      fakeLifecycle,
      'http://127.0.0.1:18099',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(captured.length, 1);
  const body = JSON.parse(captured[0].init.body) as { capabilities: Record<string, unknown> };
  const sandbox = body.capabilities.sandbox;
  const detected = getAvailableSandbox();

  // The reported value must be a concrete backend when one is installed,
  // and must never claim a sandbox that does not exist ('native'/'none').
  assert.equal(typeof sandbox, 'string');
  assert.ok(sandbox !== 'native' && sandbox !== 'none', `reported sandbox must not be native/none, got ${sandbox}`);
  if (detected !== 'native') {
    assert.equal(sandbox, detected, 'reported sandbox must match the detected backend');
  } else {
    assert.equal(sandbox, 'tool_policy', 'no OS backend installed -> legacy tool_policy marker');
  }
});
