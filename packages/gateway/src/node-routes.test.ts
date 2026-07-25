import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';

import { registerNodeRoutes } from './routes/infrastructure/node-routes.js';
import type { NodeRouteDependencies } from './routes/infrastructure/node-routes.js';

// ── Stub deps: in-memory executor node store, no DB ──

const stubNodes = new Map<string, Record<string, unknown>>();

const stubDeps: NodeRouteDependencies = {
  ensureExecutorNodeStore: async () => {},
  listExecutorNodes: async (_limit?: number) => Array.from(stubNodes.values()) as any,
  loadExecutorNode: async (nodeId: string) => (stubNodes.get(nodeId) ?? null) as any,
  recordExecutorNodeProbe: async (input) => {
    const existing = stubNodes.get(input.nodeId) ?? {};
    const updated = {
      ...existing,
      ...input,
      verified: input.verified ?? {},
      execution: (existing as any).execution ?? { candidate: false, blockers: [] },
    };
    stubNodes.set(input.nodeId, updated);
    return updated as any;
  },
  upsertExecutorNode: async (input) => {
    const existing = stubNodes.get(input.nodeId);
    const merged = { ...existing, ...input };
    stubNodes.set(input.nodeId, merged);
    return merged as any;
  },
  upsertExecutorNodeHeartbeat: async (input) => {
    const existing = stubNodes.get(input.nodeId) ?? { nodeId: input.nodeId };
    const updated = { ...existing, ...input, lastHeartbeat: new Date().toISOString() };
    stubNodes.set(input.nodeId, updated);
    return updated as any;
  },
};

test('node heartbeat persists executor draining status and active task count', async () => {
  const nodeId = `test-heartbeat-draining-${Date.now()}`;
  const app = Fastify({ logger: false });
  registerNodeRoutes(app, stubDeps);

  const response = await app.inject({
    method: 'POST',
    url: '/nodes/heartbeat',
    payload: {
      nodeId,
      status: 'draining',
      activeTaskCount: 2,
      capabilities: { run_agent: false },
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'draining');

  const stored = stubNodes.get(nodeId);
  assert.ok(stored);
  assert.equal(stored?.status, 'draining');
  assert.equal(stored?.activeTaskCount, 2);

  await app.close();
});

test('node probe verifies non-executor http_health without creating an executor candidate', async () => {
  const nodeId = `test-http-health-${Date.now()}`;
  const healthServer = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  const app = Fastify({ logger: false });
  registerNodeRoutes(app, stubDeps);

  stubNodes.set(nodeId, {
    nodeId,
    nodeKind: 'ssh_target',
    status: 'offline',
    connectModes: ['http_health'],
    connectConfig: {},
    capabilities: { run_agent: false },
    verified: {},
    queueDepth: 0,
    activeTaskCount: 0,
    meshLinks: [],
    execution: { candidate: false, blockers: ['node_kind:ssh_target'] },
  });

  try {
    await listen(healthServer);
    const address = healthServer.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}/api/v1/healthz`;
    // Update stub node with the real endpoint
    const existing = stubNodes.get(nodeId)!;
    existing.connectConfig = { http_health: { endpoint } };
    stubNodes.set(nodeId, existing);

    const response = await app.inject({
      method: 'POST',
      url: `/nodes/${nodeId}/probe`,
    });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.probe.status, 'online');
    assert.equal(data.node.verified.http_health.ok, true);
    assert.equal(data.node.execution.candidate, false);
    assert.ok(data.node.execution.blockers.includes('node_kind:ssh_target'));
  } finally {
    stubNodes.delete(nodeId);
    await closeServer(healthServer);
    await app.close();
  }
});

test('node probe parses socks5 endpoints as tcp socket targets', async () => {
  const nodeId = `test-socks5-proxy-${Date.now()}`;
  const socketServer = createServer((_req, res) => {
    res.end();
  });
  const app = Fastify({ logger: false });
  registerNodeRoutes(app, stubDeps);

  stubNodes.set(nodeId, {
    nodeId,
    nodeKind: 'proxy',
    status: 'offline',
    connectModes: ['socks5'],
    connectConfig: {},
    capabilities: { proxy_egress: true, run_agent: false },
    verified: {},
    queueDepth: 0,
    activeTaskCount: 0,
    meshLinks: [],
    execution: { candidate: false, blockers: ['node_kind:proxy'] },
  });

  try {
    await listen(socketServer);
    const address = socketServer.address() as AddressInfo;

    // Update stub node with the real sock5 endpoint
    const existing = stubNodes.get(nodeId)!;
    existing.connectConfig = { socks5: { endpoint: `socks5://127.0.0.1:${address.port}` } };
    stubNodes.set(nodeId, existing);

    const response = await app.inject({
      method: 'POST',
      url: `/nodes/${nodeId}/probe`,
    });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.probe.status, 'online');
    assert.equal(data.node.verified.socks5.ok, true);
    assert.equal(data.node.execution.candidate, false);
    assert.ok(data.node.execution.blockers.includes('node_kind:proxy'));
  } finally {
    stubNodes.delete(nodeId);
    await closeServer(socketServer);
    await app.close();
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
