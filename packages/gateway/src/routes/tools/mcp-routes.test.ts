import assert from 'node:assert/strict';
import Fastify from 'fastify';
import test from 'node:test';
import { registerMCPRoutes } from './mcp-routes.js';
import type { MCPRouteDependencies } from './mcp-routes.js';

// ── Stub deps: in-memory MCP server store, no DB ──

const stubStore = new Map<string, Record<string, unknown>>();
const stubVersions = new Map<string, Array<Record<string, unknown>>>();

function makeServer(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, enabled: false, env: {}, envKeys: [], transport: 'streamable-http',
    command: null, args: null, url: null, sourceUri: null,
    authConfig: { mode: 'none' }, toolPolicy: { allow: [], deny: [], riskLevel: 'L0' },
    adapterConfig: {}, adapterEvidence: null,
    versionHash: 'v1', status: 'disconnected', lastError: null,
    ...overrides };
}

const stubDeps: MCPRouteDependencies = {
  deleteMCPServer: async (id: string) => { stubStore.delete(id); return true; },
  inspectMCPServer: ((input: any) => {
    const normalized = {
      id: input.id,
      tenantId: input.tenantId,
      projectId: input.projectId,
      transport: input.transport,
      command: input.command ?? null,
      args: input.args ?? null,
      url: input.url ?? null,
      sourceUri: input.sourceUri ?? null,
      authConfig: input.authConfig ?? { mode: 'none' },
      toolPolicy: input.toolPolicy ?? { allow: [], deny: [], riskLevel: 'L0' },
      adapterConfig: input.adapterConfig ?? {},
    };
    const versionHash = `vh-${input.id || input.transport}`;
    return {
      executionSupported: input.transport === 'stdio' && !!input.command,
      normalized: { ...normalized, versionHash },
      versionHash,
    };
  }) as any,
  listMCPServerVersions: async (id: string) => (stubVersions.get(id) ?? []) as any,
  listMCPServers: async () => Array.from(stubStore.values()).map((s: any) => ({ ...s, env: undefined, envKeys: Object.keys(s.env ?? {}) })),
  loadMCPServer: async (id: string) => {
    const s = stubStore.get(id);
    if (!s) return null;
    return { ...s, env: undefined, envKeys: Object.keys(s.env ?? {}) } as any;
  },
  pinMCPServerVersion: async (id: string, _tenantId, _projectId, versionHash?) => {
    const s = stubStore.get(id)!;
    s.pinnedVersionHash = versionHash;
    return s as any;
  },
  projectCanToolCapability: (_tool) => ({ availability: 'blocked', reason: 'stub' }) as any,
  rollbackMCPServerVersion: async (id: string, _versionHash) => stubStore.get(id) as any,
  setMCPServerEnabled: async (id: string, enabled: boolean) => {
    const s = stubStore.get(id)!;
    s.enabled = enabled;
    return s as any;
  },
  summarizeCanToolCapabilities: (_projections) =>
    ({ projected: 3, available: 1, blocked: 2, byDataClassification: { public: 1, local_private: 1, unknown: 1 } }) as any,
  unpinMCPServerVersion: async (id: string) => { delete (stubStore.get(id) as any)?.pinnedVersionHash; return stubStore.get(id) as any; },
  updateMCPServerStatus: async (id: string, patch: any) => {
    const s = stubStore.get(id)!;
    if (patch.status) s.status = patch.status;
    if (patch.lastError !== undefined) s.lastError = patch.lastError;
    if (patch.toolCount !== undefined) (s as any).toolCount = patch.toolCount;
    if (patch.adapterEvidence) s.adapterEvidence = patch.adapterEvidence as any;
    return s as any;
  },
  upsertMCPServer: async (input: any) => {
    const existing = stubStore.get(input.id);
    const s = makeServer(input.id, { ...existing, ...input, enabled: false });
    stubStore.set(input.id, s);
    const versions = stubVersions.get(input.id) ?? [];
    versions.push({ versionHash: input.versionHash ?? 'v1', createdAt: new Date().toISOString() });
    stubVersions.set(input.id, versions);
    return s as any;
  },
  MCPClient: class {
    connect = async () => {};
    getTools = () => [{ name: 'snippet.search', title: '', description: '', inputSchema: {}, outputSchema: undefined, annotations: undefined }];
    getServerIdentity = () => ({ name: 'cantool', version: '1.0', protocolVersion: '1.0' });
    close = async () => {};
  } as any,
  ensureMCPServerStore: async () => {},
};

// Route: inspectBody() also calls deps.inspectMCPServer — needs to go through deps
// But inspectBody is called inside the route handler closures which use the injected deps.

test('MCP routes require inspect and never expose env values', async () => {
  const app = Fastify({ logger: false });
  registerMCPRoutes(app, stubDeps);
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
    await stubDeps.deleteMCPServer(id);
    await app.close();
  }
});
