import type { FastifyInstance } from 'fastify';
import type { Config } from '@los/infra/config';
import {
  listFeedAnalysisTargets,
  dispatchFeedAnalysisJob,
  getFeedAnalysisDispatch,
  type FeedAnalysisDispatchRequest,
} from '@los/agent';
import { runIdempotentJson } from '../../idempotency.js';
import { getRequestContext } from '../../request-context.js';

/**
 * Gateway routes for the feed-analysis integration.
 * Replaces the discontinued lsclaw feed-analysis ingress.
 *
 * Auth: Uses Bearer token (Authorization header), verified against
 * config.auth.token. The /api/integrations/* path prefix is excluded
 * from the global x-los-auth-token check (see auth-middleware.ts PUBLIC_PATHS).
 */
export function registerIntegrationRoutes(app: FastifyInstance, config: Config, workspaceRoot: string) {
  // ── POST /api/integrations/feed-analysis/dispatch ──────
  app.post('/api/integrations/feed-analysis/dispatch', async (req, reply) => {
    const authError = verifyIntegrationAuth(req, config);
    if (authError) return reply.status(401).send(authError);

    const body = req.body as FeedAnalysisDispatchRequest;
    if (!body?.sourceSystem || !body?.sourceJobId || !body?.deliveryMode) {
      return reply.status(400).send(wrapError('sourceSystem, sourceJobId, and deliveryMode are required'));
    }

    const idempotencyKey = extractIdempotencyKey(req);
    const context = getRequestContext(req);

    return await runIdempotentJson(
      req,
      reply,
      {
        route: '/api/integrations/feed-analysis/dispatch',
        method: 'POST',
        body,
        context,
      },
      async () => {
        const result = await dispatchFeedAnalysisJob(
          body,
          idempotencyKey ?? `fa-${context.requestId}`,
          workspaceRoot,
        );
        return wrapEnvelope(result);
      },
    );
  });

  // ── GET /api/integrations/feed-analysis/dispatch/:id ───
  app.get('/api/integrations/feed-analysis/dispatch/:id', async (req, reply) => {
    const authError = verifyIntegrationAuth(req, config);
    if (authError) return reply.status(401).send(authError);

    const { id } = req.params as { id: string };
    if (!id?.trim()) {
      return reply.status(400).send(wrapError('dispatch id is required'));
    }

    const result = await getFeedAnalysisDispatch(id.trim());
    if (!result) {
      return reply.status(404).send(wrapError('dispatch not found'));
    }
    return wrapEnvelope(result);
  });

  // ── GET /api/integrations/feed-analysis/targets ────────
  app.get('/api/integrations/feed-analysis/targets', async (req, reply) => {
    const authError = verifyIntegrationAuth(req, config);
    if (authError) return reply.status(401).send(authError);

    return wrapEnvelope(listFeedAnalysisTargets());
  });
}

// ── Auth ───────────────────────────────────────────────────

function verifyIntegrationAuth(req: { headers: Record<string, unknown> }, config: Config): object | null {
  const authHeader = req.headers['authorization'];
  const normalized = Array.isArray(authHeader) ? authHeader[0] : authHeader;

  if (!normalized || typeof normalized !== 'string') {
    return wrapError('unauthorized: missing Authorization header');
  }

  const token = normalized.startsWith('Bearer ')
    ? normalized.slice(7)
    : normalized;

  if (!config.auth.token || token !== config.auth.token) {
    return wrapError('unauthorized: invalid token');
  }

  return null;
}

function extractIdempotencyKey(req: { headers: Record<string, unknown> }): string | undefined {
  const key = req.headers['x-idempotency-key'] ?? req.headers['idempotency-key'];
  if (!key) return undefined;
  const normalized = Array.isArray(key) ? key[0] : key;
  return typeof normalized === 'string' ? normalized.trim() : undefined;
}

// ── Envelope ───────────────────────────────────────────────

function wrapEnvelope(data: unknown): { data: unknown } {
  return { data };
}

function wrapError(message: string): { error: string } {
  return { error: message };
}
