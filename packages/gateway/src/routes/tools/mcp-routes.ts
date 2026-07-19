/** Auditable MCP server distribution and lifecycle routes. */
import type { FastifyInstance } from 'fastify';
import {
  deleteMCPServer,
  ensureMCPServerStore,
  listMCPServers,
  loadMCPServer,
  updateMCPServerStatus,
  upsertMCPServer,
  type MCPServerRecord,
  type MCPTransport,
} from '@los/agent/mcp-servers';
import {
  inspectMCPServer,
  listMCPServerVersions,
  pinMCPServerVersion,
  rollbackMCPServerVersion,
  setMCPServerEnabled,
  unpinMCPServerVersion,
} from '@los/agent/mcp-distribution';
import type { MCPAuthConfig, MCPToolPolicy } from '@los/agent/mcp-distribution-policy';
import { MCPClient } from '@los/agent';
import { getLogger } from '@los/infra/logger';

const log = getLogger('gateway');

type ScopeQuery = { tenantId?: string; projectId?: string };

export function registerMCPRoutes(app: FastifyInstance): void {
  app.get('/mcp-servers', async (req) => {
    const query = req.query as ScopeQuery & { enabled?: string };
    const servers = await listMCPServers({
      tenantId: query.tenantId,
      projectId: query.projectId,
      enabled: query.enabled === 'true' ? true : query.enabled === 'false' ? false : undefined,
    });
    return { count: servers.length, servers: servers.map(_toPublicMCPServer) };
  });

  app.post('/mcp-servers/inspect', async (req, reply) => {
    try {
      const inspection = inspectBody(req.body);
      return { ...inspection, normalized: toPublicMCPInput(inspection.normalized) };
    } catch (error) {
      return reply.status(400).send({ error: messageOf(error) });
    }
  });

  app.get('/mcp-servers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as ScopeQuery;
    const server = await loadMCPServer(id, query.tenantId, query.projectId);
    if (!server) return reply.status(404).send({ error: 'MCP server not found' });
    return _toPublicMCPServer(server);
  });

  app.post('/mcp-servers', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    if (body.env !== undefined) {
      return reply.status(400).send({ error: 'raw env values are not accepted; use an opaque authConfig.credentialRef' });
    }
    try {
      const inspection = inspectBody(body);
      const inspectedVersionHash = optionalString(body.inspectedVersionHash);
      if (!inspectedVersionHash) return reply.status(400).send({ error: 'inspectedVersionHash is required' });
      if (inspectedVersionHash !== inspection.versionHash) {
        return reply.status(409).send({ error: 'MCP registration changed after inspect' });
      }
      const server = await upsertMCPServer(inspection.normalized);
      return reply.status(201).send(_toPublicMCPServer(server));
    } catch (error) {
      const message = messageOf(error);
      return reply.status(message.includes('pinned to version') ? 409 : 400).send({ error: message });
    }
  });

  app.get('/mcp-servers/:id/history', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as ScopeQuery;
    const server = await loadMCPServer(id, query.tenantId, query.projectId);
    if (!server) return reply.status(404).send({ error: 'MCP server not found' });
    return {
      currentVersionHash: server.versionHash,
      pinnedVersionHash: server.pinnedVersionHash,
      versions: await listMCPServerVersions(id, query.tenantId, query.projectId),
    };
  });

  app.post('/mcp-servers/:id/pin', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as ScopeQuery & { versionHash?: string; pinned?: boolean };
    try {
      const server = body.pinned === false
        ? await unpinMCPServerVersion(id, body.tenantId, body.projectId)
        : await pinMCPServerVersion(id, body.tenantId, body.projectId, optionalString(body.versionHash));
      return _toPublicMCPServer(server);
    } catch (error) {
      return reply.status(messageOf(error).includes('not found') ? 404 : 409).send({ error: messageOf(error) });
    }
  });

  app.post('/mcp-servers/:id/rollback', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as ScopeQuery & { versionHash?: string };
    const versionHash = optionalString(body.versionHash);
    if (!versionHash) return reply.status(400).send({ error: 'versionHash is required' });
    try {
      return _toPublicMCPServer(await rollbackMCPServerVersion(id, versionHash, body.tenantId, body.projectId));
    } catch (error) {
      return reply.status(messageOf(error).includes('not found') ? 404 : 409).send({ error: messageOf(error) });
    }
  });

  app.post('/mcp-servers/:id/enable', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as ScopeQuery & { enabled?: boolean };
    if (typeof body.enabled !== 'boolean') return reply.status(400).send({ error: 'enabled boolean is required' });
    try {
      return _toPublicMCPServer(await setMCPServerEnabled(id, body.enabled, body.tenantId, body.projectId));
    } catch (error) {
      return reply.status(messageOf(error).includes('not found') ? 404 : 409).send({ error: messageOf(error) });
    }
  });

  app.delete('/mcp-servers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as ScopeQuery;
    const ok = await deleteMCPServer(id, query.tenantId, query.projectId);
    if (!ok) return reply.status(404).send({ error: 'MCP server not found' });
    return { ok: true };
  });

  app.post('/mcp-servers/:id/verify', async (req, reply) => {
    return await verifyRegisteredServer(req, reply);
  });

  app.post('/mcp-servers/:id/reload', async (req, reply) => {
    return await verifyRegisteredServer(req, reply);
  });
}

async function verifyRegisteredServer(req: any, reply: any): Promise<unknown> {
  const { id } = req.params as { id: string };
  const query = req.query as ScopeQuery;
  await ensureMCPServerStore();
  const server = await loadMCPServer(id, query.tenantId, query.projectId);
  if (!server) return reply.status(404).send({ error: 'MCP server not found' });
  const unsupported = verificationBlocker(server);
  if (unsupported) {
    await updateMCPServerStatus(id, { status: 'error', lastError: unsupported }, query.tenantId, query.projectId);
    return reply.status(400).send({ ok: false, serverId: id, error: unsupported });
  }

  const client = new MCPClient({ command: server.command!, args: server.args, env: server.env });
  try {
    await client.connect();
    const tools = client.getTools();
    await updateMCPServerStatus(id, {
      status: 'connected',
      lastError: null,
      toolCount: tools.length,
      tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    }, query.tenantId, query.projectId);
    return { ok: true, serverId: id, toolCount: tools.length, tools: tools.map(tool => ({ name: tool.name, description: tool.description })) };
  } catch (error) {
    const message = messageOf(error);
    log.warn(`MCP server verify failed [${id}]: ${message}`);
    await updateMCPServerStatus(id, { status: 'error', lastError: message }, query.tenantId, query.projectId);
    return { ok: false, serverId: id, error: message };
  } finally {
    await client.close();
  }
}

function inspectBody(value: unknown) {
  const body = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const transport = normalizeTransport(body.transport);
  if (!transport) throw new Error('transport must be stdio, sse, or streamable-http');
  return inspectMCPServer({
    id: optionalString(body.id) ?? '',
    tenantId: optionalString(body.tenantId),
    projectId: optionalString(body.projectId),
    transport,
    command: optionalString(body.command),
    args: stringArray(body.args),
    url: optionalString(body.url),
    sourceUri: optionalString(body.sourceUri),
    authConfig: body.authConfig as MCPAuthConfig | undefined,
    toolPolicy: body.toolPolicy as MCPToolPolicy | undefined,
  });
}

export function _toPublicMCPServer(server: MCPServerRecord): Omit<MCPServerRecord, 'env'> & { envKeys: string[] } {
  const { env, ...safe } = server;
  return { ...safe, envKeys: Object.keys(env).sort() };
}

function toPublicMCPInput(input: object): Record<string, unknown> {
  const { env: _env, ...safe } = input as Record<string, unknown>;
  return safe;
}

function verificationBlocker(server: MCPServerRecord): string | undefined {
  if (server.authConfig.mode !== 'none') return `MCP auth mode ${server.authConfig.mode} has no credential resolver`;
  if (server.transport !== 'stdio') return `Remote MCP transport ${server.transport} is not implemented`;
  if (!server.command) return 'stdio command is missing';
  return undefined;
}

function normalizeTransport(value: unknown): MCPTransport | undefined {
  return value === 'stdio' || value === 'sse' || value === 'streamable-http' ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => typeof item === 'string' ? item.trim() : '').filter(Boolean) : [];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
