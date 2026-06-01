import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import { closeDb, getDb, initDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import { upsertExecutorNode } from '@los/agent/executor-nodes';
import { registerRequestContext } from './request-context.js';
import { registerNodeCommandRoutes } from './node-command-routes.js';

test('node command routes drain, promote, and record commands', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const nodeId = `test-node-command-${Date.now()}`;
  const app = Fastify({ logger: false });
  registerRequestContext(app);
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
  registerRequestContext(app);
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
