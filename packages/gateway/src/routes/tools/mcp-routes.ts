/**
 * @los/gateway/mcp-routes — MCP Server registry REST API.
 *
 * CRUD + verify + reload endpoints for the persistent MCP server registry.
 */

import type { FastifyInstance } from 'fastify';
import {
  ensureMCPServerStore,
  upsertMCPServer,
  loadMCPServer,
  listMCPServers,
  deleteMCPServer,
  updateMCPServerStatus,
  type UpsertMCPServerInput,
  type MCPTransport,
} from '@los/agent/mcp-servers';
import { MCPClient } from '@los/agent';
import { getLogger } from '@los/infra/logger';

const log = getLogger('gateway');

export function registerMCPRoutes(app: FastifyInstance): void {
  // ── List ──────────────────────────────────────────────

  app.get('/mcp-servers', async (req) => {
    const query = req.query as {
      tenantId?: string;
      projectId?: string;
      enabled?: string;
    };
    await ensureMCPServerStore();
    const servers = await listMCPServers({
      tenantId: query.tenantId,
      projectId: query.projectId,
      enabled: query.enabled === 'true' ? true : query.enabled === 'false' ? false : undefined,
    });
    return { count: servers.length, servers };
  });

  // ── Get one ───────────────────────────────────────────

  app.get('/mcp-servers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { tenantId?: string; projectId?: string };
    await ensureMCPServerStore();
    const server = await loadMCPServer(id, query.tenantId, query.projectId);
    if (!server) return reply.status(404).send({ error: 'MCP server not found' });
    return server;
  });

  // ── Create / Update ───────────────────────────────────

  app.post('/mcp-servers', async (req, reply) => {
    const body = req.body as {
      id?: string;
      tenantId?: string;
      projectId?: string;
      transport?: string;
      command?: string;
      args?: string[];
      url?: string;
      env?: Record<string, string>;
      enabled?: boolean;
    };

    const id = normalizeId(body.id);
    if (!id) return reply.status(400).send({ error: 'id is required' });

    const transport = normalizeTransport(body.transport);
    if (!transport) return reply.status(400).send({ error: 'transport must be stdio, sse, or streamable-http' });

    if (transport === 'stdio' && !body.command) {
      return reply.status(400).send({ error: 'command is required for stdio transport' });
    }
    if ((transport === 'sse' || transport === 'streamable-http') && !body.url) {
      return reply.status(400).send({ error: 'url is required for sse/streamable-http transport' });
    }

    const input: UpsertMCPServerInput = {
      id,
      tenantId: body.tenantId,
      projectId: body.projectId,
      transport,
      command: body.command,
      args: normalizeStringArray(body.args),
      url: body.url,
      env: normalizeEnv(body.env),
      enabled: body.enabled,
    };

    await ensureMCPServerStore();
    const server = await upsertMCPServer(input);
    return reply.status(201).send(server);
  });

  // ── Delete ────────────────────────────────────────────

  app.delete('/mcp-servers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { tenantId?: string; projectId?: string };
    await ensureMCPServerStore();
    const ok = await deleteMCPServer(id, query.tenantId, query.projectId);
    if (!ok) return reply.status(404).send({ error: 'MCP server not found' });
    return { ok: true };
  });

  // ── Verify (test connection) ──────────────────────────

  app.post('/mcp-servers/:id/verify', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { tenantId?: string; projectId?: string };
    await ensureMCPServerStore();
    const server = await loadMCPServer(id, query.tenantId, query.projectId);
    if (!server) return reply.status(404).send({ error: 'MCP server not found' });

    try {
      const config = serverToConfig(server);
      if (!config) {
        await updateMCPServerStatus(id, {
          status: 'error',
          lastError: 'Remote MCP servers (SSE/streamable-http) are not yet supported for verification',
        }, query.tenantId, query.projectId);
        return reply.status(400).send({
          ok: false,
          serverId: id,
          error: 'Remote MCP servers are not yet supported for verification',
        });
      }

      const client = new MCPClient(config);
      await client.connect();
      const tools = client.getTools();
      await client.close();

      await updateMCPServerStatus(id, {
        status: 'connected',
        lastError: null,
        toolCount: tools.length,
        tools: tools.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      }, query.tenantId, query.projectId);

      return {
        ok: true,
        serverId: id,
        toolCount: tools.length,
        tools: tools.map(t => ({ name: t.name, description: t.description })),
      };
    } catch (err: any) {
      const message = err?.message ?? String(err);
      log.warn(`MCP server verify failed [${id}]: ${message}`);
      await updateMCPServerStatus(id, {
        status: 'error',
        lastError: message,
      }, query.tenantId, query.projectId);
      return {
        ok: false,
        serverId: id,
        error: message,
      };
    }
  });

  // ── Reload (rediscover tools) ─────────────────────────

  app.post('/mcp-servers/:id/reload', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { tenantId?: string; projectId?: string };
    await ensureMCPServerStore();
    const server = await loadMCPServer(id, query.tenantId, query.projectId);
    if (!server) return reply.status(404).send({ error: 'MCP server not found' });

    try {
      const config = serverToConfig(server);
      if (!config) {
        return reply.status(400).send({
          ok: false,
          error: 'Remote MCP servers are not yet supported for reload',
        });
      }

      const client = new MCPClient(config);
      await client.connect();
      const tools = client.getTools();
      await client.close();

      await updateMCPServerStatus(id, {
        status: 'connected',
        lastError: null,
        toolCount: tools.length,
        tools: tools.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      }, query.tenantId, query.projectId);

      return {
        ok: true,
        serverId: id,
        toolCount: tools.length,
        tools: tools.map(t => ({ name: t.name, description: t.description })),
      };
    } catch (err: any) {
      const message = err?.message ?? String(err);
      await updateMCPServerStatus(id, {
        status: 'error',
        lastError: message,
      }, query.tenantId, query.projectId);
      return {
        ok: false,
        serverId: id,
        error: message,
      };
    }
  });
}

// ── Helpers ─────────────────────────────────────────────

function normalizeId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeTransport(value: unknown): MCPTransport | undefined {
  if (value === 'stdio' || value === 'sse' || value === 'streamable-http') return value;
  return undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const filtered = value
    .map(item => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean);
  return filtered.length > 0 ? filtered : undefined;
}

function normalizeEnv(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') env[k] = v;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function serverToConfig(server: { command?: string; args: string[]; env: Record<string, string> }): { command: string; args?: string[]; env?: Record<string, string> } | null {
  if (!server.command) return null;
  return {
    command: server.command,
    args: server.args.length > 0 ? server.args : undefined,
    env: Object.keys(server.env).length > 0 ? server.env : undefined,
  };
}
