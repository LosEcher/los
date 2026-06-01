import type { FastifyInstance } from 'fastify';
import {
  executeNodeCommand,
  ensureNodeCommandStore,
  listNodeCommands,
  loadNodeCommand,
  type NodeCommandName,
} from '@los/agent/node-commands';
import { getRequestContext } from './request-context.js';

type NodeCommandBody = {
  command?: NodeCommandName;
  commandId?: string;
  requestedBy?: string;
  traceId?: string;
  targetVersion?: string;
  timeoutMs?: number;
  reason?: string;
  args?: Record<string, unknown>;
};

export function registerNodeCommandRoutes(app: FastifyInstance): void {
  app.get('/node-commands', async (req) => {
    await ensureNodeCommandStore();
    const query = req.query as { nodeId?: string; limit?: string };
    return await listNodeCommands({
      nodeId: normalizeOptionalString(query.nodeId),
      limit: normalizePositiveInteger(query.limit),
    });
  });

  app.get('/node-commands/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = await loadNodeCommand(id);
    if (!record) return reply.status(404).send({ error: 'node command not found' });
    return record;
  });

  app.get('/nodes/:id/commands', async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as { limit?: string };
    await ensureNodeCommandStore();
    return await listNodeCommands({
      nodeId: id,
      limit: normalizePositiveInteger(query.limit),
    });
  });

  app.post('/nodes/:id/commands', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as NodeCommandBody | undefined;
    const nodeId = normalizeOptionalString(id);
    const command = normalizeCommand(body?.command);
    if (!nodeId) return reply.status(400).send({ error: 'node id is required' });
    if (!command) return reply.status(422).send({ error: 'command is required' });

    const context = getRequestContext(req);
    const record = await executeNodeCommand({
      commandId: normalizeOptionalString(body?.commandId),
      nodeId,
      command,
      requestedBy: normalizeOptionalString(body?.requestedBy) ?? context.userId,
      requestId: context.requestId,
      traceId: normalizeOptionalString(body?.traceId) ?? context.traceId,
      targetVersion: normalizeOptionalString(body?.targetVersion),
      timeoutMs: normalizePositiveInteger(body?.timeoutMs),
      reason: normalizeOptionalString(body?.reason),
      args: normalizeJsonObject(body?.args),
    });
    const statusCode = record.status === 'failed' ? 500 : record.status === 'denied' ? 409 : 202;
    return reply.status(statusCode).send({ ok: record.status !== 'failed' && record.status !== 'denied', command: record });
  });
}

function normalizeCommand(value: unknown): NodeCommandName | undefined {
  if (value === 'status' || value === 'probe' || value === 'drain' || value === 'promote' || value === 'restart' || value === 'upgrade' || value === 'rollback') {
    return value;
  }
  return undefined;
}

function normalizeJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const raw = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(raw)) return undefined;
  const int = Math.floor(raw);
  return int > 0 ? int : undefined;
}
