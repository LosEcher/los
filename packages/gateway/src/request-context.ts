import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '@los/infra/config';
import { getLogger, type Logger } from '@los/infra/logger';

const log = getLogger('request-context');

export interface RequestContext {
  requestId: string;
  traceId: string;
  tenantId: string;
  projectId: string;
  userId: string;
  /** Whether the requester has been authenticated as an operator
   *  (validated against auth.operatorToken, not a forgeable header). */
  isOperator: boolean;
  /** Request-scoped child logger with requestId and traceId bound. */
  log: Logger;
}

declare module 'fastify' {
  interface FastifyRequest {
    requestContext: RequestContext;
  }
}

export function registerRequestContext(app: FastifyInstance, config: Config): void {
  app.addHook('onRequest', async (req, reply) => {
    const requestId = normalizeHeader(req.headers['x-request-id']) ?? `req-${randomUUID()}`;
    const traceId = normalizeHeader(req.headers['x-trace-id']) ?? requestId;

    // Operator token validation — uses timing-safe comparison so an attacker
    // can't enumerate the token character by character.
    const isOperator = validateOperatorToken(
      req.headers['x-los-operator-token'],
      config.auth.operatorToken,
    );

    if (config.auth.enabled) {
      const tenantId = normalizeHeader(req.headers['x-tenant-id']);
      const projectId = normalizeHeader(req.headers['x-project-id']);
      const userId = normalizeHeader(req.headers['x-user-id']);

      if (!tenantId || !userId) {
        log.warn(`Request missing tenant/user context: tenant=${tenantId ?? '<none>'}, user=${userId ?? '<none>'} (auth enabled, headers required)`);
      }

      req.requestContext = {
        requestId,
        traceId,
        tenantId: tenantId ?? 'unknown',
        projectId: projectId ?? 'unknown',
        userId: userId ?? 'unknown',
        isOperator,
        log: getGatewayLogger().child({ requestId, traceId }),
      };

      reply.header('x-request-id', requestId);
      reply.header('x-trace-id', traceId);
      if (tenantId) reply.header('x-tenant-id', tenantId);
      if (projectId) reply.header('x-project-id', projectId);
      if (userId) reply.header('x-user-id', userId);
    } else {
      const tenantId = normalizeHeader(req.headers['x-tenant-id']) ?? 'local';
      const projectId = normalizeHeader(req.headers['x-project-id']) ?? config.defaultProjectId ?? 'los';
      const userId = normalizeHeader(req.headers['x-user-id']) ?? 'local-user';

      req.requestContext = {
        requestId,
        traceId,
        tenantId,
        projectId,
        userId,
        isOperator,
        log: getGatewayLogger().child({ requestId, traceId }),
      };

      reply.header('x-request-id', requestId);
      reply.header('x-trace-id', traceId);
      reply.header('x-tenant-id', tenantId);
      reply.header('x-project-id', projectId);
      reply.header('x-user-id', userId);
    }
  });
}

export function getRequestContext(req: FastifyRequest): RequestContext {
  const requestId = `req-${randomUUID()}`;
  return req.requestContext ?? {
    requestId,
    traceId: requestId,
    tenantId: 'local',
    projectId: 'los',
    userId: 'local-user',
    isOperator: false,
    log: getGatewayLogger().child({ requestId }),
  };
}

let _gatewayLogger: Logger | undefined;

function getGatewayLogger(): Logger {
  if (!_gatewayLogger) _gatewayLogger = getLogger('gateway');
  return _gatewayLogger;
}

function normalizeHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Validate the x-los-operator-token header against the configured operatorToken.
 * Uses timing-safe comparison to prevent timing side-channel enumeration.
 * When no operatorToken is configured, operator access is disabled entirely.
 */
function validateOperatorToken(
  headerValue: string | string[] | undefined,
  configuredToken: string | undefined,
): boolean {
  if (!configuredToken) return false;
  const provided = normalizeHeader(headerValue);
  if (!provided) return false;

  // timingSafeEqual requires equal-length buffers, so we compare the header value
  // against a known-good reference using a fixed-time comparison.
  const a = Buffer.from(provided);
  const b = Buffer.from(configuredToken);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
