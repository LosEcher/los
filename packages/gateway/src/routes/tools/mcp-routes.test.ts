import assert from 'node:assert/strict';
import Fastify from 'fastify';
import test from 'node:test';
import { registerMCPRoutes } from './mcp-routes.js';
import type { MCPRouteDependencies } from './mcp-routes.js';

// ── Stub deps: in-memory MCP server store, no DB ──

const stubStore = new Map<string, Record<string, unknown>>();
const stubVersions = new Map<string, Array<Record<string, unknown>>>();
const clientConfigs: Array<Record<string, unknown>> = [];

function makeServer(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, enabled: false, env: {}, envKeys: [], transport: 'streamable-http',
    command: null, args: null, url: null, sourceUri: null, headers: undefined,
    authConfig: { mode: 'none' }, toolPolicy: { allow: [], deny: [], riskLevel: 'L0' },
    adapterConfig: { kind: 'generic' }, adapterEvidence: null,
    versionHash: 'v1', status: 'disconnected', lastError: null,
    ...overrides };
}

const stubDeps: MCPRouteDependencies = {
  deleteMCPServer: async (id: string) => { stubStore.delete(id); return true; },
  inspectMCPServer: ((input: any) => {
    const authConfig = input.authConfig ?? { mode: 'none' };
    if (authConfig.mode === 'credential_ref') {
      const ref = String(authConfig.credentialRef ?? '');
      if (!/^(?:env:|local-file:|external:|adapter:)/.test(ref)) {
        throw new Error('credentialRef must be an approved opaque backend reference');
      }
    }
    const normalized = {
      id: input.id,
      tenantId: input.tenantId,
      projectId: input.projectId,
      transport: input.transport,
      command: input.command ?? null,
      args: input.args ?? null,
      url: input.url ?? null,
      sourceUri: input.sourceUri ?? null,
      authConfig,
      toolPolicy: input.toolPolicy ?? { allow: [], deny: [], riskLevel: 'L0' },
      adapterConfig: input.adapterConfig ?? { kind: 'generic' },
    };
    const versionHash = `vh-${input.id || input.transport}`;
    const blockers: string[] = [];
    if (authConfig.mode === 'oauth') blockers.push('unsupported auth mode oauth');
    return {
      executionSupported: blockers.length === 0,
      blockers,
      normalized: { ...normalized, versionHash },
      versionHash,
    };
  }) as any,
  listMCPServerVersions: async (id: string) => (stubVersions.get(id) ?? []) as any,
  listMCPServers: async () => Array.from(stubStore.values()).map((s: any) => ({ ...s, env: undefined, envKeys: Object.keys(s.env ?? {}) })),
  loadMCPServer: async (id: string) => {
    const s = stubStore.get(id);
    if (!s) return null;
    return {
      ...s,
      env: (s as any).env ?? {},
      envKeys: Object.keys((s as any).env ?? {}),
      args: (s as any).args ?? [],
      adapterConfig: (s as any).adapterConfig ?? { kind: 'generic' },
    } as any;
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
    const s = makeServer(input.id, { ...existing, ...input, enabled: false, env: input.env ?? {} });
    stubStore.set(input.id, s);
    const versions = stubVersions.get(input.id) ?? [];
    versions.push({ versionHash: input.versionHash ?? 'v1', createdAt: new Date().toISOString() });
    stubVersions.set(input.id, versions);
    return s as any;
  },
  MCPClient: class {
    constructor(config: Record<string, unknown>) {
      clientConfigs.push(config);
    }
    connect = async () => {};
    getTools = () => [{ name: 'snippet.search', title: '', description: '', inputSchema: {}, outputSchema: undefined, annotations: undefined }];
    getServerIdentity = () => ({ name: 'cantool', version: '1.0', protocolVersion: '1.0' });
    close = async () => {};
  } as any,
  ensureMCPServerStore: async () => {},
  resolveMCPCredentialRef: async (auth, opts) => {
    const mode = auth?.mode ?? 'none';
    if (mode === 'none') return { ok: true as const, env: {} as Record<string, string>, headers: {} as Record<string, string>, backend: 'none' as const };
    if (mode === 'oauth') return { ok: false as const, reason: 'unsupported auth mode oauth' };
    const ref = auth?.credentialRef ?? '';
    if (ref === 'env:MCP_ROUTE_TOKEN') {
      const value = process.env.MCP_ROUTE_TOKEN;
      if (!value) return { ok: false as const, reason: 'env credential missing: MCP_ROUTE_TOKEN' };
      if (opts.transport === 'stdio') {
        return {
          ok: true as const,
          env: { MCP_ROUTE_TOKEN: value } as Record<string, string>,
          headers: {} as Record<string, string>,
          backend: 'env' as const,
        };
      }
      return {
        ok: true as const,
        env: {} as Record<string, string>,
        headers: { Authorization: `Bearer ${value}` } as Record<string, string>,
        backend: 'env' as const,
      };
    }
    return { ok: false as const, reason: 'credential_ref not resolved' };
  },
};

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
    assert.match(verify.json().error, /oauth/);
    const history = await app.inject({ method: 'GET', url: `/mcp-servers/${id}/history` });
    assert.equal(history.statusCode, 200);
    assert.equal(history.json().versions.length, 1);
  } finally {
    await stubDeps.deleteMCPServer(id);
    await app.close();
  }
});

test('MCP verify builds full remote config and applies credential_ref headers without leaking secrets', async () => {
  const app = Fastify({ logger: false });
  registerMCPRoutes(app, stubDeps);
  const id = `mcp-remote-verify-${Date.now()}`;
  const previous = process.env.MCP_ROUTE_TOKEN;
  process.env.MCP_ROUTE_TOKEN = 'route-secret-value';
  clientConfigs.length = 0;
  try {
    stubStore.set(id, makeServer(id, {
      transport: 'streamable-http',
      url: 'https://example.invalid/mcp',
      authConfig: { mode: 'credential_ref', credentialRef: 'env:MCP_ROUTE_TOKEN' },
      versionHash: 'vh-remote',
      status: 'unverified',
    }));

    const verify = await app.inject({ method: 'POST', url: `/mcp-servers/${id}/verify` });
    assert.equal(verify.statusCode, 200);
    const body = verify.json();
    assert.equal(body.ok, true);
    assert.equal(body.credentialBackend, 'env');
    assert.equal(body.toolCount, 1);
    assert.doesNotMatch(JSON.stringify(body), /route-secret-value/);

    assert.equal(clientConfigs.length, 1);
    const captured = clientConfigs[0]!;
    assert.equal(captured.transport, 'streamable-http');
    assert.equal(captured.url, 'https://example.invalid/mcp');
    assert.deepEqual(captured.headers, { Authorization: 'Bearer route-secret-value' });
    assert.equal(captured.command, undefined);

    const stored = stubStore.get(id)!;
    assert.equal(stored.status, 'connected');
    assert.doesNotMatch(JSON.stringify(stored), /route-secret-value/);
  } finally {
    if (previous === undefined) delete process.env.MCP_ROUTE_TOKEN;
    else process.env.MCP_ROUTE_TOKEN = previous;
    await stubDeps.deleteMCPServer(id);
    await app.close();
  }
});

test('MCP verify fail-closed when credential_ref env is missing', async () => {
  const app = Fastify({ logger: false });
  registerMCPRoutes(app, stubDeps);
  const id = `mcp-missing-cred-${Date.now()}`;
  const previous = process.env.MCP_ROUTE_TOKEN;
  delete process.env.MCP_ROUTE_TOKEN;
  try {
    stubStore.set(id, makeServer(id, {
      transport: 'sse',
      url: 'https://example.invalid/sse',
      authConfig: { mode: 'credential_ref', credentialRef: 'env:MCP_ROUTE_TOKEN' },
      versionHash: 'vh-missing',
    }));
    const verify = await app.inject({ method: 'POST', url: `/mcp-servers/${id}/verify` });
    assert.equal(verify.statusCode, 400);
    assert.match(verify.json().error, /missing/i);
    assert.equal(stubStore.get(id)!.status, 'error');
  } finally {
    if (previous === undefined) delete process.env.MCP_ROUTE_TOKEN;
    else process.env.MCP_ROUTE_TOKEN = previous;
    await stubDeps.deleteMCPServer(id);
    await app.close();
  }
});

test('MCP verify builds stdio config with auth none', async () => {
  const app = Fastify({ logger: false });
  registerMCPRoutes(app, stubDeps);
  const id = `mcp-stdio-verify-${Date.now()}`;
  clientConfigs.length = 0;
  try {
    stubStore.set(id, makeServer(id, {
      transport: 'stdio',
      command: process.execPath,
      args: ['fixture.js'],
      url: null,
      authConfig: { mode: 'none' },
      env: {},
    }));
    const verify = await app.inject({ method: 'POST', url: `/mcp-servers/${id}/verify` });
    assert.equal(verify.statusCode, 200);
    assert.equal(verify.json().ok, true);
    assert.equal(clientConfigs.length, 1);
    const captured = clientConfigs[0]!;
    assert.equal(captured.transport, 'stdio');
    assert.equal(captured.command, process.execPath);
    assert.deepEqual(captured.args, ['fixture.js']);
  } finally {
    await stubDeps.deleteMCPServer(id);
    await app.close();
  }
});
