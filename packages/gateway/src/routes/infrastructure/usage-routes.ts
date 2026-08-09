/**
 * Usage routes — L1 runtime usage cube (los-owned evidence only).
 *
 * GET /usage/summary
 */

import type { FastifyInstance } from 'fastify';
import { getUsageSummary, type UsageSummaryQuery } from '@los/agent/usage-summary';

type UsageRouteDependencies = {
  getUsageSummary: typeof getUsageSummary;
};

const defaultDependencies: UsageRouteDependencies = {
  getUsageSummary,
};

export function registerUsageRoutes(
  app: FastifyInstance,
  overrides: Partial<UsageRouteDependencies> = {},
): void {
  const dependencies = { ...defaultDependencies, ...overrides };

  app.get('/usage/summary', async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const input: UsageSummaryQuery = {
      from: optionalString(query.from),
      to: optionalString(query.to),
      provider: optionalString(query.provider),
      model: optionalString(query.model),
    };
    try {
      return await dependencies.getUsageSummary(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: 'invalid_usage_query', message });
    }
  });
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
