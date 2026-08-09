import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { evaluateExecutorNode } from '@los/agent/executor-nodes';
import { probeNode } from './routes/node-probes.js';

test('probeNode verifies every connect mode, including preferred agent_http_ndjson', async () => {
  let healthHits = 0;
  const healthServer = createServer((_req, res) => {
    healthHits += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });

  try {
    await listen(healthServer);
    const address = healthServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const result = await probeNode({
      nodeId: 'probe-multi-mode',
      nodeKind: 'executor',
      baseUrl,
      status: 'online',
      connectModes: ['agent_http', 'agent_http_ndjson'],
      // Only agent_http is configured — ndjson must inherit it for endpoint resolution.
      connectConfig: {
        agent_http: { baseUrl },
      },
      capacity: {},
      capabilities: { run_agent: true },
      verified: {},
      queueDepth: 0,
      activeTaskCount: 0,
      meshLinks: [],
      lastHeartbeatAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      execution: { candidate: false, mode: 'agent_http_ndjson', blockers: [], warnings: [] },
    });

    assert.equal(result.status, 'online');
    assert.equal((result.verified.agent_http as { ok?: boolean })?.ok, true);
    assert.equal((result.verified.agent_http_ndjson as { ok?: boolean })?.ok, true);
    assert.equal(
      (result.verified.agent_http as { endpoint?: string })?.endpoint,
      `${baseUrl}/health`,
    );
    assert.equal(
      (result.verified.agent_http_ndjson as { endpoint?: string })?.endpoint,
      `${baseUrl}/health`,
    );
    // Both modes share one health URL; both must still be probed (no early return).
    assert.equal(healthHits, 2);

    const execution = evaluateExecutorNode({
      nodeId: 'probe-multi-mode',
      nodeKind: 'executor',
      baseUrl,
      status: 'online',
      connectModes: ['agent_http', 'agent_http_ndjson'],
      connectConfig: { agent_http: { baseUrl } },
      capacity: {},
      capabilities: { run_agent: true },
      verified: result.verified,
      queueDepth: 0,
      activeTaskCount: 0,
      meshLinks: [],
      lastHeartbeatAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    assert.equal(execution.mode, 'agent_http_ndjson');
    assert.equal(execution.candidate, true);
    assert.deepEqual(execution.blockers, []);
  } finally {
    await closeServer(healthServer);
  }
});

test('probeNode stays online when a secondary mode fails but preferred succeeds', async () => {
  const healthServer = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });

  try {
    await listen(healthServer);
    const address = healthServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const result = await probeNode({
      nodeId: 'probe-partial-fail',
      nodeKind: 'executor',
      baseUrl,
      status: 'online',
      connectModes: ['agent_http', 'agent_http_ndjson', 'http_health'],
      connectConfig: {
        agent_http: { baseUrl },
        // Missing/unreachable http_health endpoint should not poison agent modes.
        http_health: { endpoint: 'http://127.0.0.1:1/missing' },
      },
      capacity: {},
      capabilities: { run_agent: true },
      verified: {},
      queueDepth: 0,
      activeTaskCount: 0,
      meshLinks: [],
      lastHeartbeatAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      execution: { candidate: false, mode: 'agent_http_ndjson', blockers: [], warnings: [] },
    });

    assert.equal(result.status, 'online');
    assert.equal((result.verified.agent_http as { ok?: boolean })?.ok, true);
    assert.equal((result.verified.agent_http_ndjson as { ok?: boolean })?.ok, true);
    assert.equal((result.verified.http_health as { ok?: boolean })?.ok, false);
    assert.equal(result.lastProbeError, undefined);
  } finally {
    await closeServer(healthServer);
  }
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
