import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import { registerToolGateRoutes } from './routes/orchestration/tool-gate-routes.js';

test('tool feedback is restored by a new gateway instance', async () => {
  const suffix = randomUUID();
  const sessionId = `tool-gate-${suffix}`;
  const projectId = `tool-gate-project-${suffix}`;
  const filePath = `src/failed-${suffix}.ts`;
  const firstGateway = Fastify();
  registerToolGateRoutes(firstGateway);

  const feedback = await firstGateway.inject({
    method: 'POST',
    url: '/operator/tool-feedback',
    payload: {
      callId: 'failed-call',
      toolName: 'write',
      args: { file_path: filePath },
      ok: false,
      error: 'typecheck failed',
      sessionId,
      projectId,
    },
  });
  assert.equal(feedback.statusCode, 200);
  assert.equal(feedback.json().failureFingerprints, 1);
  await firstGateway.close();

  const secondGateway = Fastify();
  registerToolGateRoutes(secondGateway);
  const gate = await secondGateway.inject({
    method: 'POST',
    url: '/operator/tool-gate',
    payload: {
      callId: 'retry-call',
      toolName: 'write',
      args: { file_path: filePath },
      sessionId: `retry-${suffix}`,
      projectId,
    },
  });
  assert.equal(gate.statusCode, 200);
  assert.equal(gate.json().allowed, true);
  assert.equal(gate.json().knownFailure, true);
  assert.deepEqual(gate.json().flaggedFiles, [filePath]);
  await secondGateway.close();
});

test('operator fragile-file changes persist and can be removed', async () => {
  const filePath = `src/operator-${randomUUID()}.ts`;
  const app = Fastify();
  registerToolGateRoutes(app);

  const added = await app.inject({
    method: 'POST',
    url: '/operator/tool-gate/fragile-files',
    payload: { action: 'add', paths: [filePath] },
  });
  assert.equal(added.statusCode, 200);
  assert.equal(added.json().fragileFiles.includes(filePath), true);

  const removed = await app.inject({
    method: 'POST',
    url: '/operator/tool-gate/fragile-files',
    payload: { action: 'remove', paths: [filePath] },
  });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.json().fragileFiles.includes(filePath), false);
  await app.close();
});
