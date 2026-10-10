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
      undefined,
      'heartbeat-key',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(captured.length, 1);
  assert.equal(captured[0].init.headers.authorization, 'Bearer heartbeat-key');
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

// ── ADR 0048 B3: per-node credential on the heartbeat (send side first) ──────

async function captureHeartbeat(nodeCredential?: string) {
  const originalFetch = globalThis.fetch;
  const captured: any[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    captured.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await heartbeatNode(
      'heartbeat-credential-test',
      'http://127.0.0.1:18099',
      'test-version',
      'executor',
      ['agent_http'],
      fakeLifecycle,
      'http://127.0.0.1:18099',
      undefined,
      'heartbeat-key',
      nodeCredential,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(captured.length, 1);
  return captured[0].init.headers as Record<string, string>;
}

test('heartbeat sends the per-node credential when the node is enrolled', async () => {
  const headers = await captureHeartbeat('node-credential-abc');
  assert.equal(headers['x-los-node-credential'], 'node-credential-abc');
  // The shared executor key still authorizes the transport; the credential is
  // additional identity, not a replacement.
  assert.equal(headers.authorization, 'Bearer heartbeat-key');
});

test('heartbeat omits the per-node credential when the node is not enrolled yet', async () => {
  const headers = await captureHeartbeat(undefined);
  assert.equal('x-los-node-credential' in headers, false);
  assert.equal(headers.authorization, 'Bearer heartbeat-key');
});
