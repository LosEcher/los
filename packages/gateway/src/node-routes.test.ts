import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';

import { closeDb, getDb, initDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import { upsertExecutorNode } from '@los/agent/executor-nodes';
import { registerNodeRoutes } from './routes/infrastructure/node-routes.js';

test('node probe verifies non-executor http_health without creating an executor candidate', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const nodeId = `test-http-health-${Date.now()}`;
  const healthServer = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  const app = Fastify({ logger: false });
  registerNodeRoutes(app);

  try {
    await listen(healthServer);
    const address = healthServer.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}/api/v1/healthz`;

    await upsertExecutorNode({
      nodeId,
      nodeKind: 'ssh_target',
      status: 'offline',
      connectModes: ['http_health'],
      connectConfig: {
        http_health: { endpoint },
      },
      capabilities: { run_agent: false },
    });

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
    await getDb().query('DELETE FROM executor_nodes WHERE node_id = $1', [nodeId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
    await closeServer(healthServer);
    await app.close();
  }
});

test('node probe parses socks5 endpoints as tcp socket targets', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const nodeId = `test-socks5-proxy-${Date.now()}`;
  const socketServer = createServer((_req, res) => {
    res.end();
  });
  const app = Fastify({ logger: false });
  registerNodeRoutes(app);

  try {
    await listen(socketServer);
    const address = socketServer.address() as AddressInfo;

    await upsertExecutorNode({
      nodeId,
      nodeKind: 'proxy',
      status: 'offline',
      connectModes: ['socks5'],
      connectConfig: {
        socks5: { endpoint: `socks5://127.0.0.1:${address.port}` },
      },
      capabilities: { proxy_egress: true, run_agent: false },
    });

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
    await getDb().query('DELETE FROM executor_nodes WHERE node_id = $1', [nodeId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
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
