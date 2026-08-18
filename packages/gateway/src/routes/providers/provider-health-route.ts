/**
 * Provider health projection — read-only snapshot of the in-memory health
 * scores computed by the provider probe loop (provider-probe + provider-health,
 * ADR 0031). Consumed by dashboards and by DSH-style clients that want to
 * fail-fast before calling an unhealthy provider instead of discovering the
 * failure mid-request.
 *
 * Returns whatever the probe loop has computed so far; an empty list means the
 * loop has not produced scores yet (probe interval is 60s while active, 300s
 * idle), not that providers are down.
 */
import type { FastifyInstance } from 'fastify';
import { getAllCachedHealthScores } from '@los/agent/providers/health';

export function registerProviderHealthRoute(app: FastifyInstance): void {
  app.get('/providers/health', async () => ({
    probedAt: new Date().toISOString(),
    providers: getAllCachedHealthScores(),
  }));
}
