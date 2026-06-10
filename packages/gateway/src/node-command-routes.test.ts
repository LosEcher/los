import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';

import { closeDb, getDb, initDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import { upsertExecutorNode } from '@los/agent/executor-nodes';
import { registerRequestContext } from './request-context.js';
import { registerNodeCommandRoutes } from './routes/node-command-routes.js';

test('node command routes drain, promote, and record commands', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const nodeId = `test-node-command-${Date.now()}`;
  const app = Fastify({ logger: false });
  registerRequestContext(app, config);
  registerNodeCommandRoutes(app);

  try {
    await upsertExecutorNode({
      nodeId,
      nodeKind: 'executor',
      status: 'online',
      connectModes: ['agent_http'],
      connectConfig: { agent_http: { baseUrl: 'http://127.0.0.1:1' } },
      capabilities: { run_agent: true },
      verified: { agent_http: { ok: true } },
    });

    const drainResponse = await app.inject({
      method: 'POST',
      url: `/nodes/${nodeId}/commands`,
      payload: { command: 'drain', reason: 'test drain' },
    });
    assert.equal(drainResponse.statusCode, 202);
    const drain = drainResponse.json();
    assert.equal(drain.command.status, 'succeeded');
    assert.equal(drain.command.output.node.status, 'draining');
    assert.equal(drain.command.output.node.rolloutState, 'draining');

    const promoteResponse = await app.inject({
      method: 'POST',
      url: `/nodes/${nodeId}/commands`,
      payload: { command: 'promote', reason: 'test promote' },
    });
    assert.equal(promoteResponse.statusCode, 202);
    const promote = promoteResponse.json();
    assert.equal(promote.command.status, 'succeeded');
    assert.equal(promote.command.output.node.status, 'online');
    assert.equal(promote.command.output.node.rolloutState, 'idle');

    const listResponse = await app.inject({ method: 'GET', url: `/nodes/${nodeId}/commands` });
    assert.equal(listResponse.statusCode, 200);
    assert.equal(listResponse.json().length, 2);
  } finally {
    await getDb().query('DELETE FROM node_commands WHERE node_id = $1', [nodeId]).catch(() => undefined);
    await getDb().query('DELETE FROM executor_nodes WHERE node_id = $1', [nodeId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
    await app.close();
  }
});

test('node upgrade command records accepted rollout state without pretending to restart', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const nodeId = `test-node-upgrade-${Date.now()}`;
  const app = Fastify({ logger: false });
  registerRequestContext(app, config);
  registerNodeCommandRoutes(app);

  try {
    await upsertExecutorNode({
      nodeId,
      nodeKind: 'executor',
      status: 'online',
      version: '0.1.0',
      connectModes: ['agent_http'],
      connectConfig: { agent_http: { baseUrl: 'http://127.0.0.1:1' } },
      capabilities: { run_agent: true },
      verified: { agent_http: { ok: true } },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/nodes/${nodeId}/commands`,
      payload: { command: 'upgrade', targetVersion: '0.2.0', reason: 'test upgrade' },
    });
    assert.equal(response.statusCode, 202);
    const data = response.json();
    assert.equal(data.command.status, 'accepted');
    assert.equal(data.command.output.node.status, 'draining');
    assert.equal(data.command.output.node.targetVersion, '0.2.0');
    assert.equal(data.command.output.node.rolloutState, 'draining');
    assert.match(data.command.output.nextAction, /drain\/restart\/verify/);
  } finally {
    await getDb().query('DELETE FROM node_commands WHERE node_id = $1', [nodeId]).catch(() => undefined);
    await getDb().query('DELETE FROM executor_nodes WHERE node_id = $1', [nodeId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
    await app.close();
  }
});

test('node command routes proxy to advertised executor command url', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const nodeId = `test-node-command-proxy-${Date.now()}`;
  const gateway = Fastify({ logger: false });
  const executor = Fastify({ logger: false });
  let authorization: string | undefined;
  let proxiedBody: Record<string, unknown> = {};

  executor.post('/v1/nodes/:id/commands', async (req, reply) => {
    const { id } = req.params as { id: string };
    authorization = req.headers.authorization;
    proxiedBody = req.body as Record<string, unknown>;
    return reply.status(202).send({
      ok: true,
      command: {
        commandId: 'proxy-command',
        nodeId: id,
        command: proxiedBody.command,
        status: 'succeeded',
        args: {},
        output: { source: 'executor-proxy' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
  });

  registerRequestContext(gateway, config);
  registerNodeCommandRoutes(gateway, { executorAgentKey: 'proxy-key' });
  await executor.listen({ host: '127.0.0.1', port: 0 });
  const address = executor.server.address() as AddressInfo;

  try {
    await upsertExecutorNode({
      nodeId,
      nodeKind: 'executor',
      status: 'online',
      connectModes: ['agent_http'],
      connectConfig: {
        agent_http: {
          commandUrl: `http://127.0.0.1:${address.port}/v1/nodes/${nodeId}/commands`,
        },
      },
      capabilities: { node_command_runner: true },
      verified: { agent_http: { ok: true } },
    });

    const response = await gateway.inject({
      method: 'POST',
      url: `/nodes/${nodeId}/commands`,
      payload: { command: 'status', reason: 'proxy test' },
    });
    assert.equal(response.statusCode, 202);
    assert.equal(response.json().command.output.source, 'executor-proxy');
    assert.equal(authorization, 'Bearer proxy-key');
    assert.equal(proxiedBody.nodeId, nodeId);
    assert.equal(proxiedBody.command, 'status');
    assert.equal(proxiedBody.reason, 'proxy test');
  } finally {
    await getDb().query('DELETE FROM executor_nodes WHERE node_id = $1', [nodeId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
    await gateway.close();
    await executor.close();
  }
});
