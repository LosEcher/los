import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { Config } from '@los/infra/config';
import {
  listFeedAnalysisTargets,
  dispatchFeedAnalysisJob,
  getFeedAnalysisDispatch,
  getFeedAnalysisResult,
  cancelFeedAnalysisDispatch,
  listFeedAnalysisDeadLetters,
  replayFeedAnalysisDeadLetter,
  FeedAnalysisError,
  type FeedAnalysisDispatchRequest,
} from '@los/agent';
import { runIdempotentJson } from '../../idempotency.js';
import { getRequestContext, type RequestContext } from '../../request-context.js';

/**
 * Gateway routes for the feed-analysis integration.
 * Replaces the discontinued lsclaw feed-analysis ingress.
 *
 * Auth: Uses Bearer token (Authorization header), verified against the
 * dedicated feed-analysis service token. The /api/integrations/* path prefix is excluded
 * from the global x-los-auth-token check (see auth-middleware.ts PUBLIC_PATHS).
 */
export function registerIntegrationRoutes(app: FastifyInstance, config: Config, workspaceRoot: string) {
  // ── POST /api/integrations/feed-analysis/dispatch ──────
  app.post('/api/integrations/feed-analysis/dispatch', {
    bodyLimit: config.integrations.feedAnalysis.maxInlineBytes + 64 * 1024,
  }, async (req, reply) => {
    const authError = verifyIntegrationAuth(req, config);
    if (authError) return reply.status(authError.status).send(authError.body);

    const body = req.body as FeedAnalysisDispatchRequest;
    if (!body?.sourceSystem || !body?.sourceJobId || !body?.deliveryMode) {
      return reply.status(400).send(wrapError('invalid_request', 'sourceSystem, sourceJobId, and deliveryMode are required'));
    }

    const idempotencyKey = extractIdempotencyKey(req);
    const context = normalizeIntegrationContext(req, getRequestContext(req), config, body.sourceSystem);
    const callbackProfileId = body.callback?.profileId?.trim();
    if (body.deliveryMode === 'result_returning' && !config.integrations.feedAnalysis.resultReturningEnabled) {
      return reply.status(422).send(wrapError('capability_unsupported', 'result_returning is disabled'));
    }
    if (callbackProfileId && !config.integrations.feedAnalysis.callbackProfiles[callbackProfileId]) {
      return reply.status(422).send(wrapError('capability_unsupported', 'callback profile is not configured'));
    }

    try {
      reply.status(202);
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
            {
              workspaceRoot,
              tenantId: context.tenantId,
              projectId: context.projectId,
              userId: context.userId,
              requestId: context.requestId,
              provider: config.agent.defaultProvider,
              model: config.agent.defaultModel,
              timeoutMs: config.integrations.feedAnalysis.executionTimeoutMs,
              maxInlineBytes: config.integrations.feedAnalysis.maxInlineBytes,
              maxItems: config.integrations.feedAnalysis.maxItems,
              materialHosts: config.integrations.feedAnalysis.materialHosts,
              materialFetchTimeoutMs: config.integrations.feedAnalysis.materialFetchTimeoutMs,
            },
          );
          return wrapEnvelope(result);
        },
      );
    } catch (error) {
      return sendIntegrationError(reply, error);
    }
  });

  // ── GET /api/integrations/feed-analysis/dispatch/:id ───
  app.get('/api/integrations/feed-analysis/dispatch/:id', async (req, reply) => {
    const authError = verifyIntegrationAuth(req, config);
    if (authError) return reply.status(authError.status).send(authError.body);

    const { id } = req.params as { id: string };
    if (!id?.trim()) {
      return reply.status(400).send(wrapError('invalid_request', 'dispatch id is required'));
    }

    const result = await getFeedAnalysisDispatch(id.trim());
    if (!result) {
      return reply.status(404).send(wrapError('dispatch_not_found', 'dispatch not found'));
    }
    return wrapEnvelope(result);
  });

  app.get('/api/integrations/feed-analysis/dispatch/:id/result', async (req, reply) => {
    const authError = verifyIntegrationAuth(req, config);
    if (authError) return reply.status(authError.status).send(authError.body);
    const { id } = req.params as { id: string };
    if (!id?.trim()) return reply.status(400).send(wrapError('invalid_request', 'dispatch id is required'));
    const result = await getFeedAnalysisResult(id.trim());
    if (!result) return reply.status(404).send(wrapError('dispatch_not_found', 'dispatch not found'));
    if (!result.resultAvailable && (result.status === 'accepted' || result.status === 'queued' || result.status === 'processing')) {
      return reply.status(202).send(wrapEnvelope(result));
    }
    return wrapEnvelope(result);
  });

  app.post('/api/integrations/feed-analysis/dispatch/:id/cancel', async (req, reply) => {
    const authError = verifyIntegrationAuth(req, config);
    if (authError) return reply.status(authError.status).send(authError.body);
    const { id } = req.params as { id: string };
    const body = req.body as { reason?: string } | undefined;
    if (!id?.trim()) return reply.status(400).send(wrapError('invalid_request', 'dispatch id is required'));
    try {
      return wrapEnvelope(await cancelFeedAnalysisDispatch(id.trim(), body?.reason?.trim()));
    } catch (error) {
      return sendIntegrationError(reply, error);
    }
  });

  app.get('/api/integrations/feed-analysis/callbacks/dead-letter', async (req, reply) => {
    const authError = verifyIntegrationAuth(req, config);
    if (authError) return reply.status(authError.status).send(authError.body);
    const query = req.query as { limit?: string };
    const limit = Number(query.limit ?? 50);
    return wrapEnvelope({ deliveries: await listFeedAnalysisDeadLetters(Number.isFinite(limit) ? limit : 50) });
  });

  app.post('/api/integrations/feed-analysis/callbacks/:id/replay', async (req, reply) => {
    const authError = verifyIntegrationAuth(req, config);
    if (authError) return reply.status(authError.status).send(authError.body);
    const { id } = req.params as { id: string };
    if (!id?.trim()) return reply.status(400).send(wrapError('invalid_request', 'delivery id is required'));
    const replayed = await replayFeedAnalysisDeadLetter(id.trim());
    if (!replayed) return reply.status(404).send(wrapError('callback_delivery_not_found', 'dead-letter delivery not found'));
    return wrapEnvelope({ deliveryId: id.trim(), replayed: true });
  });

  // ── GET /api/integrations/feed-analysis/targets ────────
  app.get('/api/integrations/feed-analysis/targets', async (req, reply) => {
    const authError = verifyIntegrationAuth(req, config);
    if (authError) return reply.status(authError.status).send(authError.body);

    const integration = config.integrations.feedAnalysis;
    return wrapEnvelope(listFeedAnalysisTargets({
      callbackEnabled: Object.keys(integration.callbackProfiles).length > 0,
      resultReturningEnabled: integration.resultReturningEnabled,
      maxInlineBytes: integration.maxInlineBytes,
      maxItems: integration.maxItems,
    }));
  });
}

// ── Auth ───────────────────────────────────────────────────

function verifyIntegrationAuth(
  req: { headers: Record<string, unknown> },
  config: Config,
): { status: 401 | 503; body: object } | null {
  const configuredToken = config.integrations.feedAnalysis.serviceToken;
  if (!configuredToken) {
    return { status: 503, body: wrapError('workflow_unavailable', 'feed-analysis integration token is not configured') };
  }
  const authHeader = req.headers['authorization'];
  const normalized = Array.isArray(authHeader) ? authHeader[0] : authHeader;

  if (!normalized || typeof normalized !== 'string') {
    return { status: 401, body: wrapError('integration_unauthorized', 'missing Authorization header') };
  }

  const token = normalized.startsWith('Bearer ')
    ? normalized.slice(7)
    : normalized;

  if (!tokensEqual(token, configuredToken)) {
    return { status: 401, body: wrapError('integration_unauthorized', 'invalid token') };
  }

  return null;
}

function normalizeIntegrationContext(
  req: { headers: Record<string, unknown> },
  context: RequestContext,
  config: Config,
  sourceSystem: string,
): RequestContext {
  const actor = normalizeHeader(req.headers['x-actor-id']);
  return {
    ...context,
    tenantId: context.tenantId === 'unknown' ? 'local' : context.tenantId,
    projectId: context.projectId === 'unknown' ? config.defaultProjectId ?? 'los' : context.projectId,
    userId: context.userId === 'unknown' ? actor ?? `integration:${sourceSystem}` : context.userId,
  };
}

function normalizeHeader(value: unknown): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
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

function wrapError(code: string, message?: string): { error: string; message: string } {
  return { error: code, message: message ?? code };
}

function tokensEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function sendIntegrationError(reply: import('fastify').FastifyReply, error: unknown): unknown {
  if (error instanceof FeedAnalysisError) {
    return reply.status(error.httpStatus).send(wrapError(error.code, error.message));
  }
  throw error;
}
