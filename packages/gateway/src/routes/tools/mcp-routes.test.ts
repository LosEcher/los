import assert from 'node:assert/strict';
import Fastify from 'fastify';
import test from 'node:test';
import { deleteMCPServer } from '@los/agent/mcp-servers';
import { registerMCPRoutes } from './mcp-routes.js';

test('MCP routes require inspect and never expose env values', async () => {
  const app = Fastify({ logger: false });
  registerMCPRoutes(app);
  const id = `mcp-route-${Date.now()}`;
  try {
    const rejected = await app.inject({
      method: 'POST',
      url: '/mcp-servers',
      payload: { id, transport: 'stdio', command: process.execPath, env: { SECRET: 'raw' } },
    });
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.json().error, /raw env values/);

    const inspect = await app.inject({
      method: 'POST',
      url: '/mcp-servers/inspect',
      payload: {
        id,
        transport: 'streamable-http',
        url: 'https://example.invalid/mcp',
        sourceUri: 'catalog:test/remote@1',
        authConfig: { mode: 'oauth', credentialRef: 'vault:mcp/remote' },
        toolPolicy: { allow: ['search'], deny: [], riskLevel: 'L0' },
      },
    });
    assert.equal(inspect.statusCode, 200);
    const preview = inspect.json();
    assert.equal(preview.executionSupported, false);

    const create = await app.inject({
      method: 'POST',
      url: '/mcp-servers',
      payload: { ...preview.normalized, inspectedVersionHash: preview.versionHash },
    });
    assert.equal(create.statusCode, 201);
    const created = create.json();
    assert.equal(created.enabled, false);
    assert.equal(created.env, undefined);
    assert.deepEqual(created.envKeys, []);
    assert.equal(created.authConfig.mode, 'oauth');
    assert.deepEqual(created.toolPolicy.allow, ['search']);

    const verify = await app.inject({ method: 'POST', url: `/mcp-servers/${id}/verify` });
    assert.equal(verify.statusCode, 400);
    assert.match(verify.json().error, /no credential resolver/);
    const history = await app.inject({ method: 'GET', url: `/mcp-servers/${id}/history` });
    assert.equal(history.statusCode, 200);
    assert.equal(history.json().versions.length, 1);
  } finally {
    await deleteMCPServer(id);
    await app.close();
  }
});
