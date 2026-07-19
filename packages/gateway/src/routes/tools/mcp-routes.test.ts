import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import test from 'node:test';
import { deleteMCPServer } from '@los/agent/mcp-servers';
import { registerMCPRoutes } from './mcp-routes.js';

const cantoolFixture = fileURLToPath(new URL('../../../../agent/src/tools/external/fixtures/mcp-cantool-server.mjs', import.meta.url));

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

test('MCP verify persists CanTool capability and lifecycle evidence without enabling execution', async () => {
  const app = Fastify({ logger: false });
  registerMCPRoutes(app);
  const id = `cantool-route-${Date.now()}`;
  try {
    const inspect = await app.inject({
      method: 'POST',
      url: '/mcp-servers/inspect',
      payload: {
        id,
        transport: 'stdio',
        command: process.execPath,
        args: [cantoolFixture],
        adapterConfig: { kind: 'cantool' },
      },
    });
    assert.equal(inspect.statusCode, 200);
    const preview = inspect.json();
    const create = await app.inject({
      method: 'POST',
      url: '/mcp-servers',
      payload: { ...preview.normalized, inspectedVersionHash: preview.versionHash },
    });
    assert.equal(create.statusCode, 201);
    assert.equal(create.json().enabled, false);

    const verify = await app.inject({ method: 'POST', url: `/mcp-servers/${id}/verify` });
    assert.equal(verify.statusCode, 200);
    assert.deepEqual(verify.json().adapterEvidence.capabilitySummary, {
      projected: 3,
      available: 1,
      blocked: 2,
      byDataClassification: { public: 1, local_private: 1, unknown: 1 },
    });

    const stored = await app.inject({ method: 'GET', url: `/mcp-servers/${id}` });
    assert.equal(stored.json().adapterConfig.kind, 'cantool');
    assert.equal(stored.json().adapterEvidence.serverName, 'cantool');
    assert.equal(stored.json().tools.find((tool: any) => tool.name === 'snippet.search').capability.availability, 'blocked');
    assert.equal(stored.json().enabled, false);
  } finally {
    await deleteMCPServer(id);
    await app.close();
  }
});
