import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

import { closeDb, getDb, initDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import { registerRequestContext } from './request-context.js';
import { registerArtifactRoutes } from './routes/tools/artifact-routes.js';
import { upsertExecutorNode } from '@los/agent/executor-nodes';

test('artifact routes put, read, list, and delete a local artifact', async () => {
  const config = await loadConfig();
  config.auth.enabled = false;
  await initDb(config.databaseUrl);

  const artifactId = `test-artifact-${Date.now()}`;
  const sessionId = `test-session-${Date.now()}`;
  const storageRoot = await mkdtemp(join(tmpdir(), 'los-artifacts-'));
  const app = Fastify({ logger: false });
  registerRequestContext(app, config);
  registerArtifactRoutes(app, { storageRoot });

  try {
    const putResponse = await app.inject({
      method: 'POST',
      url: '/artifacts',
      payload: {
        artifactId,
        nodeId: 'gateway-local',
        sessionId,
        path: 'notes/smoke.txt',
        pathPolicy: 'artifact-store',
        content: 'artifact smoke',
        contentType: 'text/plain',
        metadata: { purpose: 'test' },
      },
    });
    assert.equal(putResponse.statusCode, 201);
    const put = putResponse.json();
    assert.equal(put.artifact.artifactId, artifactId);
    assert.equal(put.artifact.nodeId, 'gateway-local');
    assert.equal(put.artifact.sizeBytes, 14);
    assert.equal(put.artifact.checksumAlgorithm, 'sha256');

    const listResponse = await app.inject({ method: 'GET', url: `/artifacts?sessionId=${sessionId}` });
    assert.equal(listResponse.statusCode, 200);
    const list = listResponse.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].artifactId, artifactId);

    const contentResponse = await app.inject({ method: 'GET', url: `/artifacts/${artifactId}/content` });
    assert.equal(contentResponse.statusCode, 200);
    assert.equal(contentResponse.body, 'artifact smoke');
    assert.equal(contentResponse.headers['x-artifact-id'], artifactId);

    const events = await getDb().query<{ type: string }>(
      'SELECT type FROM session_events WHERE session_id = $1 ORDER BY id ASC',
      [sessionId],
    );
    assert.deepEqual(events.rows.map(row => row.type), ['artifact.put', 'artifact.get']);

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/artifacts/${artifactId}`,
      payload: { reason: 'test cleanup' },
    });
    assert.equal(deleteResponse.statusCode, 200);
    assert.ok(deleteResponse.json().artifact.deletedAt);
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM artifacts WHERE artifact_id = $1', [artifactId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
    await app.close();
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('artifact route accepts payloads above the gateway chat body limit', async () => {
  const config = await loadConfig();
  config.auth.enabled = false;
  await initDb(config.databaseUrl);

  const artifactId = `test-artifact-large-${Date.now()}`;
  const sessionId = `test-session-large-${Date.now()}`;
  const storageRoot = await mkdtemp(join(tmpdir(), 'los-artifacts-'));
  const app = Fastify({ logger: false });
  registerRequestContext(app, config);
  registerArtifactRoutes(app, { storageRoot });

  try {
    const content = 'x'.repeat(1024 * 1024 + 128);
    const putResponse = await app.inject({
      method: 'POST',
      url: '/artifacts',
      payload: {
        artifactId,
        nodeId: 'gateway-local',
        sessionId,
        path: 'notes/large.txt',
        pathPolicy: 'artifact-store',
        content,
        contentType: 'text/plain',
      },
    });

    assert.equal(putResponse.statusCode, 201);
    assert.equal(putResponse.json().artifact.sizeBytes, content.length);
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM artifacts WHERE artifact_id = $1', [artifactId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
    await app.close();
    await rm(storageRoot, { recursive: true, force: true });
  }
});


test('artifact relay pushes to an executor and indexes the remote copy', async () => {
  const config = await loadConfig();
  config.auth.enabled = false;
  await initDb(config.databaseUrl);

  const artifactId = `test-relay-${Date.now()}`;
  const nodeId = `relay-target-${Date.now()}`;
  const storageRoot = await mkdtemp(join(tmpdir(), 'los-artifacts-'));
  const content = Buffer.from('relay payload', 'utf8');
  const checksum = createHash('sha256').update(content).digest('hex');
  const received: Array<{ method: string; url: string; body: string }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      received.push({ method: req.method ?? '', url: req.url ?? '', body });
      if (req.method === 'POST' && req.url === '/v1/artifacts') {
        const parsed = JSON.parse(body) as { artifactId: string; nodeId: string };
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          artifact: {
            artifactId: parsed.artifactId,
            nodeId: parsed.nodeId,
            sizeBytes: content.length,
            checksum,
            contentType: 'text/plain',
            originalPath: 'notes/relay.txt',
            pathPolicy: 'artifact-store',
          },
        }));
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/v1/artifacts/') && req.url.endsWith('/content')) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(content);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const app = Fastify({ logger: false });
  registerRequestContext(app, config);
  registerArtifactRoutes(app, { storageRoot });

  try {
    await upsertExecutorNode({
      nodeId,
      nodeKind: 'executor',
      status: 'online',
      baseUrl: `http://127.0.0.1:${address.port}`,
      connectModes: ['agent_http'],
      capabilities: { run_agent: true, workspace_read: true },
      verified: { agent_http: { ok: true, checked_at: new Date().toISOString() } },
    });
    const put = await app.inject({
      method: 'POST',
      url: '/artifacts',
      payload: {
        artifactId,
        nodeId: 'gateway-local',
        path: 'notes/relay.txt',
        pathPolicy: 'artifact-store',
        content: content.toString('base64'),
        encoding: 'base64',
        contentType: 'text/plain',
      },
    });
    assert.equal(put.statusCode, 201);

    const relay = await app.inject({
      method: 'POST',
      url: `/artifacts/${artifactId}/relay`,
      payload: { nodeId },
    });
    assert.equal(relay.statusCode, 201, relay.body);
    assert.equal(relay.json().artifact.nodeId, nodeId);
    assert.equal(relay.json().artifact.storagePath, `executor://${nodeId}/${artifactId}-relay-${nodeId}`);
    assert.equal(received[0]?.method, 'POST');
    assert.equal(received[0]?.url, '/v1/artifacts');
    const pushed = JSON.parse(received[0]!.body) as { nodeId: string; content: string; encoding: string };
    assert.equal(pushed.nodeId, nodeId);
    assert.equal(pushed.encoding, 'base64');
    assert.equal(Buffer.from(pushed.content, 'base64').toString('utf8'), content.toString('utf8'));

    // Remove the local row so the gateway must use the relay index and fetch
    // from the owner executor (the collision the first relay design hit).
    await getDb().query('DELETE FROM artifacts WHERE artifact_id = $1', [artifactId]);
    const read = await app.inject({ method: 'GET', url: `/artifacts/${artifactId}/content` });
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.body, content.toString('utf8'));
    assert.equal(received.some(item => item.method === 'GET' && item.url.endsWith(`/${artifactId}-relay-${nodeId}/content`)), true);
  } finally {
    await getDb().query('DELETE FROM artifacts WHERE artifact_id = $1', [artifactId]).catch(() => undefined);
    await getDb().query('DELETE FROM artifact_relay_index WHERE artifact_id = $1', [artifactId]).catch(() => undefined);
    await getDb().query('DELETE FROM executor_nodes WHERE node_id = $1', [nodeId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
    await app.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(storageRoot, { recursive: true, force: true });
  }
});
