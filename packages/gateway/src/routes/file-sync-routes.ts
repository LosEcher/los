import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export function registerFileSyncRoutes(app: FastifyInstance, opts: { executorAgentKey?: string }): void {
  const agentKey = opts.executorAgentKey;

  app.get('/file-sync/status', async () => {
    const { listExecutorNodes } = await import('@los/agent/executor-nodes');
    const nodes = await listExecutorNodes();
    const results: Array<{ nodeId: string; folders?: unknown; error?: string }> = [];

    for (const node of nodes) {
      const caps = (node.capabilities ?? {}) as Record<string, unknown>;
      if (!caps.file_sync_scan) continue;
      const cfg = (node.connectConfig ?? {}) as Record<string, unknown>;
      const httpCfg = (cfg.agent_http ?? {}) as Record<string, unknown>;
      const healthUrl = String(httpCfg.healthUrl ?? node.baseUrl ?? '').replace(/\/+$/, '');
      if (!healthUrl || !agentKey) continue;

      try {
        const res = await fetch(`${healthUrl.replace('/health', '')}/v1/file-sync/status`, {
          headers: { Authorization: `Bearer ${agentKey}` },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const body = await res.json() as Record<string, unknown>;
          results.push({ nodeId: node.nodeId, folders: body.folders ?? body });
        }
      } catch {
        // unreachable
      }
    }

    return { ok: true, nodes: results };
  });

  app.get('/file-sync/events', async (req: FastifyRequest) => {
    const query = (req.query ?? {}) as Record<string, string>;
    const limit = Math.min(Number(query.limit) || 50, 500);
    const { listExecutorNodes } = await import('@los/agent/executor-nodes');
    const nodes = await listExecutorNodes();

    const allEvents: unknown[] = [];
    for (const node of nodes) {
      const caps = (node.capabilities ?? {}) as Record<string, unknown>;
      if (!caps.file_sync_scan) continue;
      const cfg = (node.connectConfig ?? {}) as Record<string, unknown>;
      const httpCfg = (cfg.agent_http ?? {}) as Record<string, unknown>;
      const healthUrl = String(httpCfg.healthUrl ?? node.baseUrl ?? '').replace(/\/+$/, '');
      if (!healthUrl || !agentKey) continue;

      try {
        const res = await fetch(`${healthUrl.replace('/health', '')}/v1/file-sync/events?limit=${limit}`, {
          headers: { Authorization: `Bearer ${agentKey}` },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const body = await res.json() as { events?: unknown[] };
          if (body.events) allEvents.push(...body.events);
        }
      } catch {
        // skip
      }
    }

    return { ok: true, events: allEvents.slice(0, limit) };
  });

  app.post('/file-sync/scan', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const nodeId = typeof body.nodeId === 'string' ? body.nodeId : undefined;
    if (!nodeId) return reply.status(400).send({ error: 'nodeId is required' });

    const { loadExecutorNode } = await import('@los/agent/executor-nodes');
    const node = await loadExecutorNode(nodeId);
    if (!node) return reply.status(404).send({ error: 'node not found' });

    const cfg = (node.connectConfig ?? {}) as Record<string, unknown>;
    const httpCfg = (cfg.agent_http ?? {}) as Record<string, unknown>;
    const healthUrl = String(httpCfg.healthUrl ?? node.baseUrl ?? '').replace(/\/+$/, '');
    if (!healthUrl || !agentKey) return reply.status(400).send({ error: 'no executor endpoint' });

    try {
      const res = await fetch(`${healthUrl.replace('/health', '')}/v1/file-sync/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agentKey}` },
        body: JSON.stringify({
          folder: body.folder,
          path: body.path,
          mode: body.mode,
        }),
        signal: AbortSignal.timeout(300_000),
      });
      const result = await res.json() as Record<string, unknown>;
      return { ok: true, nodeId, ...result };
    } catch (err) {
      return reply.status(502).send({ error: 'executor unreachable', detail: String(err) });
    }
  });
}
