import type { FastifyInstance } from 'fastify';
import {
  executeNodeCommand,
  ensureNodeCommandStore,
  listNodeCommands,
  loadNodeCommand,
  type NodeCommandName,
} from '@los/agent/node-commands';
import { isNodeCommandName, listNodeCommandNames } from '@los/agent';
import { loadExecutorNode } from '@los/agent/executor-nodes';
import { getRequestContext, requireOperator } from '../../request-context.js';

type NodeCommandRoutesOptions = {
  executorAgentKey?: string;
};

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

export function registerNodeCommandRoutes(app: FastifyInstance, options: NodeCommandRoutesOptions = {}): void {
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
    if (!(await requireOperator(req, reply))) return;
    const { id } = req.params as { id: string };
    const body = req.body as NodeCommandBody | undefined;
    const nodeId = normalizeOptionalString(id);
    const command = normalizeCommand(body?.command);
    if (!nodeId) return reply.status(400).send({ error: 'node id is required' });
    if (!command) {
      // 自描述错误：把允许的命令列出来（清单来自 @los/agent 的单一真源）
      return reply.status(422).send({
        error: `command is required and must be one of: ${listNodeCommandNames().join(', ')}`,
      });
    }

    const context = getRequestContext(req);
    const commandInput = {
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
    };
    const proxied = await proxyNodeCommand(commandInput, options.executorAgentKey);
    if (proxied) return reply.status(proxied.statusCode).send(proxied.body);

    const record = await executeNodeCommand(commandInput);
    const statusCode = record.status === 'failed' ? 500 : record.status === 'denied' ? 409 : 202;
    return reply.status(statusCode).send({ ok: record.status !== 'failed' && record.status !== 'denied', command: record });
  });
}

async function proxyNodeCommand(
  input: NodeCommandBody & { nodeId: string; command: NodeCommandName },
  executorAgentKey: string | undefined,
): Promise<{ statusCode: number; body: unknown } | null> {
  const node = await loadExecutorNode(input.nodeId);
  const commandUrl = normalizeOptionalString(normalizeJsonObject(node?.connectConfig?.agent_http)?.commandUrl);
  if (!commandUrl) return null;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (executorAgentKey) headers.Authorization = `Bearer ${executorAgentKey}`;
  const response = await fetch(commandUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) as unknown : {};
  if (!response.ok && response.status >= 500) {
    throw new Error(`executor node command failed: ${response.status} ${response.statusText}: ${text}`);
  }
  return { statusCode: response.status, body };
}

function normalizeCommand(value: unknown): NodeCommandName | undefined {
  // 单一清单在 @los/agent/node-commands（2026-10-11 收敛，避免加命令时三处不同步）
  return isNodeCommandName(value) ? value : undefined;
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
