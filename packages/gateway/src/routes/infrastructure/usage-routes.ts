/**
 * Usage + daily digest + runtime health routes — L1 runtime evidence only.
 *
 * GET /usage/summary
 * GET /ops/daily-digest
 * POST /ops/daily-digest/push  — emit ops.daily_digest for channel bots
 * GET /ops/runtime-health
 */

import type { FastifyInstance } from 'fastify';
import {
  getDailyDigest,
  publishDailyDigest,
  type DailyDigestQuery,
} from '@los/agent/daily-digest';
import { getRuntimeHealth } from '@los/agent/runtime-health';
import { getUsageSummary, type UsageSummaryQuery } from '@los/agent/usage-summary';

type UsageRouteDependencies = {
  getUsageSummary: typeof getUsageSummary;
  getDailyDigest: typeof getDailyDigest;
  publishDailyDigest: typeof publishDailyDigest;
  getRuntimeHealth: typeof getRuntimeHealth;
};

const defaultDependencies: UsageRouteDependencies = {
  getUsageSummary,
  getDailyDigest,
  publishDailyDigest,
  getRuntimeHealth,
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

  app.get('/ops/daily-digest', async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const input: DailyDigestQuery = {
      day: optionalString(query.day),
      projectId: optionalString(query.projectId),
      tenantId: optionalString(query.tenantId),
    };
    try {
      return await dependencies.getDailyDigest(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: 'invalid_daily_digest_query', message });
    }
  });

  /** Compose digest and emit session event for WeChat/Telegram SSE consumers. */
  app.post('/ops/daily-digest/push', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const query = req.query as Record<string, unknown>;
    const input: DailyDigestQuery = {
      day: optionalString(body.day) ?? optionalString(query.day),
      projectId: optionalString(body.projectId) ?? optionalString(query.projectId),
      tenantId: optionalString(body.tenantId) ?? optionalString(query.tenantId),
    };
    try {
      const result = await dependencies.publishDailyDigest(input);
      return {
        ok: true,
        day: result.digest.day,
        eventEmitted: result.eventEmitted,
        enabledCount: result.digest.schedule.enabledCount,
        runTotals: result.digest.schedule.runTotals,
        messagePreview: result.message.slice(0, 280),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: 'daily_digest_push_failed', message });
    }
  });

  // Aggregated board only — never claims work (2026-08-09 control-plane decision).
  app.get('/ops/runtime-health', async (_req, reply) => {
    try {
      return await dependencies.getRuntimeHealth();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: 'runtime_health_failed', message });
    }
  });
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
