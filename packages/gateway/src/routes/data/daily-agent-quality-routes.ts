import type { FastifyInstance } from 'fastify';

import {
  captureDailyAgentQuality,
  getDailyAgentQualityBaseline,
} from '@los/agent/daily-agent-quality';

import { getRequestContext, requireOperator } from '../../request-context.js';

export function registerDailyAgentQualityRoutes(app: FastifyInstance): void {
  app.get('/daily-agent-quality/baseline', async (req) => {
    const context = getRequestContext(req);
    const query = req.query as { days?: string };
    return await getDailyAgentQualityBaseline({
      tenantId: context.tenantId,
      projectId: context.projectId,
      requiredDays: boundedDays(query.days),
    });
  });

  app.post('/daily-agent-quality/capture', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const context = getRequestContext(req);
    const result = await captureDailyAgentQuality({
      tenantId: context.tenantId,
      projectId: context.projectId,
    });
    return reply.status(201).send(result);
  });
}

function boundedDays(value: unknown): number {
  const parsed = Number(value ?? 28);
  if (!Number.isFinite(parsed)) return 28;
  return Math.min(90, Math.max(1, Math.floor(parsed)));
}
