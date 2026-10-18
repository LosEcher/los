import test from 'node:test';
import assert from 'node:assert/strict';
import { getAvailableSandbox } from '@los/agent';
import { heartbeatNode, resolveNodeVersion } from './executor-heartbeat.js';
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

test('heartbeat returns the gateway credential hints, and tolerates an empty body', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      ok: true,
      credentialExpiresAt: '2026-11-17T00:00:00.000Z',
      credentialRotationDue: true,
    }), { status: 200 })) as typeof fetch;
    assert.deepEqual(await heartbeatNode(
      'heartbeat-credential-hints',
      'http://127.0.0.1:18099', 'v', 'executor', ['agent_http'], fakeLifecycle,
      'http://127.0.0.1:18099', undefined, 'heartbeat-key', 'node-credential-abc',
    ), {
      ok: true,
      credentialExpiresAt: '2026-11-17T00:00:00.000Z',
      credentialRotationDue: true,
    });

    // Older gateways / empty responses must not turn a successful heartbeat into a failure.
    globalThis.fetch = (async () => new Response('', { status: 200 })) as typeof fetch;
    assert.deepEqual(await heartbeatNode(
      'heartbeat-empty-body',
      'http://127.0.0.1:18099', 'v', 'executor', ['agent_http'], fakeLifecycle,
      'http://127.0.0.1:18099', undefined, 'heartbeat-key', 'node-credential-abc',
    ), {});
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Control-plane §1: version provenance on the heartbeat ───────────────────

test('NEGATIVE CONTROL: a node without LOS_VERSION reports package_json, not a content hash', () => {
  const id = resolveNodeVersion({ packageVersion: '0.1.0' });
  assert.equal(id.version, '0.1.0');
  assert.equal(id.versionSource, 'package_json');
  assert.ok(!id.version.includes('+b'), 'unpinned node must not look pinned');
});

test('EXECUTOR_VERSION or LOS_VERSION counts as env', () => {
  assert.deepEqual(
    resolveNodeVersion({ executorVersion: '0.1.0+bd79957fb2e5' }),
    { version: '0.1.0+bd79957fb2e5', versionSource: 'env' },
  );
  assert.deepEqual(
    resolveNodeVersion({ serverVersion: '0.1.0+b47a933663dc' }),
    { version: '0.1.0+b47a933663dc', versionSource: 'env' },
  );
  // EXECUTOR_VERSION wins when both are present (it is the node's own pin).
  assert.equal(
    resolveNodeVersion({ executorVersion: '0.1.0+baaaa', serverVersion: '0.1.0+bbbb' }).version,
    '0.1.0+baaaa',
  );
});

test('blank versions are absent, and nothing at all is unversioned', () => {
  // Blank strings must fall through to the package fallback, not be reported as
  // a version that happens to be whitespace.
  assert.equal(
    resolveNodeVersion({ executorVersion: '  ', serverVersion: '', packageVersion: '0.1.0' }).versionSource,
    'package_json',
  );
  assert.deepEqual(resolveNodeVersion({}), { version: 'unknown', versionSource: 'unversioned' });
});

test('the heartbeat payload carries capabilities.versionSource', async () => {
  const originalFetch = globalThis.fetch;
  const captured: any[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    captured.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await heartbeatNode(
      'heartbeat-version-source-test',
      'http://127.0.0.1:18099',
      '0.1.0+bdeadbeef000',
      'executor',
      ['agent_http'],
      fakeLifecycle,
      'http://127.0.0.1:18099',
      undefined,
      'heartbeat-key',
      undefined,
      'env',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  const body = JSON.parse(captured[0].init.body) as { version: string; capabilities: Record<string, unknown> };
  assert.equal(body.version, '0.1.0+bdeadbeef000');
  assert.equal(body.capabilities.versionSource, 'env');
  // The offline/DB path must not need a new column: provenance rides in capabilities.
  assert.ok(!('version_source' in body), 'no new top-level column on the heartbeat payload');
});
