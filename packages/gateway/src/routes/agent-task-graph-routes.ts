import type { FastifyInstance } from 'fastify';
import {
  getAgentTaskGraphCompletion,
  readAgentTaskGraph,
} from '@los/agent';

export function registerAgentTaskGraphRoutes(app: FastifyInstance): void {
  app.get('/agent-graphs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as { requireVerifier?: string };
    return await readAgentTaskGraph(id, {
      requireVerifier: normalizeBoolean(query.requireVerifier),
    });
  });

  app.get('/agent-graphs/:id/completion', async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as { requireVerifier?: string };
    return await getAgentTaskGraphCompletion(id, {
      requireVerifier: normalizeBoolean(query.requireVerifier),
    });
  });
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}
