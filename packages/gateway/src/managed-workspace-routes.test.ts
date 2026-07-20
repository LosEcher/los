import assert from 'node:assert/strict';
import Fastify from 'fastify';
import test from 'node:test';
import { getConfig, setConfig } from '@los/infra/config';
import { registerManagedWorkspaceRoutes } from './routes/orchestration/managed-workspace-routes.js';
import { registerRequestContext } from './request-context.js';

test('managed workspace mutations require operator privilege and exact release confirmation', async () => {
  const original = getConfig();
  const config = { ...original, auth: { enabled: true, token: 'access-token', operatorToken: 'operator-token' } };
  setConfig(config);
  const app = Fastify({ logger: false });
  registerRequestContext(app, config);
  registerManagedWorkspaceRoutes(app, { artifactStorageRoot: '/tmp/los-test-artifacts' });

  try {
    for (const request of [
      { method: 'POST' as const, url: '/agent-graphs/graph-1/workspaces', payload: {} },
      { method: 'POST' as const, url: '/managed-workspaces/workspace-1/backup', payload: {} },
      { method: 'POST' as const, url: '/managed-workspaces/workspace-1/release', payload: { confirm: 'workspace-1' } },
    ]) {
      const response = await app.inject({ ...request, headers: { 'x-los-auth-token': 'access-token' } });
      assert.equal(response.statusCode, 403, request.url);
      assert.deepEqual(response.json(), { error: 'operator token required' });
    }

    const wrongConfirm = await app.inject({
      method: 'POST',
      url: '/managed-workspaces/workspace-1/release',
      headers: { 'x-los-operator-token': 'operator-token' },
      payload: { confirm: 'wrong-id' },
    });
    assert.equal(wrongConfirm.statusCode, 409);
    assert.deepEqual(wrongConfirm.json(), { error: 'confirm must exactly match workspace id' });
  } finally {
    setConfig(original);
    await app.close();
  }
});
