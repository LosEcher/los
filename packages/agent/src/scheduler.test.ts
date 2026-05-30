import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { closeDb, getDb, initDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import { upsertExecutorNode } from './executor-nodes.js';
import { runScheduledAgentTask } from './scheduler.js';

test('scheduler uses a verified registry executor when nodeUrls is empty', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const nodeId = `test-scheduler-executor-${suffix}`;
  const taskRunId = `task-${suffix}`;
  const sessionId = `session-${suffix}`;
  const requests: Array<Record<string, unknown>> = [];

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/tasks/run-agent') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    requests.push(JSON.parse(await readRequestBody(req)));
    sendJson(res, {
      events: [],
      deltas: [],
      result: {
        text: 'executor ok',
        turns: [],
        loopCount: 0,
        totalTokens: { prompt: 0, completion: 0 },
        messages: [],
      },
    });
  });

  try {
    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await upsertExecutorNode({
      nodeId,
      nodeKind: 'executor',
      status: 'online',
      baseUrl,
      connectModes: ['agent_http'],
      connectConfig: {
        agent_http: { baseUrl },
      },
      capabilities: { run_agent: true },
      verified: {
        agent_http: { ok: true, checked_at: new Date().toISOString() },
      },
    });

    const result = await runScheduledAgentTask({
      prompt: 'use registry executor',
      taskRunId,
      sessionId,
      workspaceRoot: process.cwd(),
      executor: {
        enabled: true,
        nodeUrls: [],
        nodeId,
      },
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.taskRun.nodeId, nodeId);
    assert.equal(result.result.text, 'executor ok');
    assert.equal(requests[0]?.nodeId, nodeId);
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE id = $1', [taskRunId]).catch(() => undefined);
    await getDb().query('DELETE FROM executor_nodes WHERE node_id = $1', [nodeId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
    await closeServer(server);
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

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, body: unknown): void {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}
