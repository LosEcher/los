import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

import { closeDb, getDb, initDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import { registerRequestContext } from './request-context.js';
import { registerArtifactRoutes } from './routes/tools/artifact-routes.js';

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
