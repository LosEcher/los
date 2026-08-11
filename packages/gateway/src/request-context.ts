import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getConfig, type Config } from '@los/infra/config';
import { getLogger, type Logger } from '@los/infra/logger';
import type { MessagePrincipal, OperatorPrincipal } from '@los/agent/message-router';
import { verifyJwt, getJwtSecret, type JwtPayload } from './auth-store.js';

const log = getLogger('request-context');
const LOCAL_OPERATOR_SUBJECT = 'operator:local';
const SHARED_OPERATOR_SUBJECT = 'operator:shared-token';
const JWT_OPERATOR_SUBJECT = 'operator:jwt';
const SHARED_ACCESS_SUBJECT = 'authenticated:shared-token';
const JWT_ACCESS_SUBJECT = 'authenticated:jwt';
const CONTEXT_OPTIONAL_INFRA_PATHS = new Set(['/health', '/live', '/ready', '/nodes/heartbeat']);

export interface RequestContext {
  requestId: string;
  traceId: string;
  tenantId: string;
  projectId: string;
  userId: string;
  /** Whether the requester has been authenticated as an operator
   *  (validated against auth.operatorToken, not a forgeable header). */
  isOperator: boolean;
  /** Whether the requester supplied any validated gateway credential. */
  isAuthenticated: boolean;
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

    // Resolve JWT claims from Bearer token (user login).
    const jwtPayload = resolveJwtPayload(req);

    // Operator token validation — uses timing-safe comparison.
    const isStaticOperator = validateOperatorToken(
      req.headers['x-los-operator-token'],
      config.auth.operatorToken,
    );
    // JWT-based operator: user with role='operator'
    const isJwtOperator = jwtPayload?.role === 'operator';
    const isOperator = isStaticOperator || isJwtOperator;

    const hasStaticAccess = validateAccessToken(req, config.auth.token);
    const isAuthenticated = isOperator || hasStaticAccess || !!jwtPayload;

    if (config.auth.enabled) {
      // Scope headers are routing hints, not authorization claims. Only a
      // validated operator may override the configured tenant/project scope.
      const tenantId = isOperator
        ? normalizeHeader(req.headers['x-tenant-id']) ?? 'local'
        : 'local';
      const projectId = isOperator
        ? normalizeHeader(req.headers['x-project-id']) ?? config.defaultProjectId ?? 'los'
        : config.defaultProjectId ?? 'los';
      // Operator token without JWT/x-user-id must still produce an auditable
      // actor (SHARED_OPERATOR_SUBJECT). Falling through to 'unknown' previously
      // wrote canaryAuthorization.grantedBy=unknown on real K4 grants.
      const userId = jwtPayload?.sub
        ?? (isOperator
          ? (normalizeHeader(req.headers['x-user-id']) ?? SHARED_OPERATOR_SUBJECT)
          : undefined)
        ?? (hasStaticAccess ? SHARED_ACCESS_SUBJECT : 'unknown');

      if (!jwtPayload && _requiresActorContext(req.url)) {
        const hdrUser = normalizeHeader(req.headers['x-user-id']);
        if (!hdrUser) {
          log.warn(`Request missing user context: user=<none> (auth enabled, no JWT)`);
        }
      }

      req.requestContext = {
        requestId,
        traceId,
        tenantId,
        projectId,
        userId,
        isOperator,
        isAuthenticated,
        log: getGatewayLogger().child({ requestId, traceId }),
      };

      reply.header('x-request-id', requestId);
      reply.header('x-trace-id', traceId);
      reply.header('x-tenant-id', tenantId);
      reply.header('x-project-id', projectId);
      reply.header('x-user-id', userId);
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
        isAuthenticated: true,
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

export function _requiresActorContext(url: string | undefined): boolean {
  if (!url) return true;
  const path = url.split('?')[0] || url;
  return !CONTEXT_OPTIONAL_INFRA_PATHS.has(path);
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
    isAuthenticated: false,
    log: getGatewayLogger().child({ requestId }),
  };
}

/**
 * Enforce operator privilege on an operator-only endpoint (steering, operator
 * event stream, security scan, etc.). Sends 403 and returns false when the
 * gateway has auth enabled but the requester is not an operator — i.e. the
 * `x-los-operator-token` header is missing or does not match the configured
 * `auth.operatorToken`.
 *
 * When auth is disabled (local single-user dev), there is no auth boundary and
 * the request proceeds (returns true). This mirrors the `auth-middleware`
 * access gate, which also short-circuits when `auth.enabled === false`.
 *
 * Operator privilege is validated in the request-context `onRequest` hook via
 * `validateOperatorToken` (timing-safe), so `isOperator` cannot be forged by
 * the caller. Returns true when the handler should proceed.
 */
export async function requireOperator(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (!hasOperatorAccess(req)) {
    await reply.code(403).send({ error: 'operator token required' });
    return false;
  }
  return true;
}

function hasOperatorAccess(req: FastifyRequest): boolean {
  return !getConfig().auth.enabled || getRequestContext(req).isOperator;
}

export function getMessagePrincipal(req: FastifyRequest): MessagePrincipal {
  const ctx = getRequestContext(req);
  const common = {
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    userId: ctx.userId,
  };
  if (!getConfig().auth.enabled) {
    return {
      kind: 'operator',
      subject: LOCAL_OPERATOR_SUBJECT,
      authenticatedBy: 'auth_disabled',
      capabilities: ['operator:*'],
      ...common,
    };
  }
  if (ctx.isOperator) {
    const isJwtOp = ctx.isOperator && !validateOperatorToken(
      req.headers['x-los-operator-token'],
      getConfig().auth.operatorToken,
    );
    return {
      kind: 'operator',
      subject: isJwtOp ? JWT_OPERATOR_SUBJECT : SHARED_OPERATOR_SUBJECT,
      authenticatedBy: isJwtOp ? 'jwt' : 'operator_token',
      capabilities: ['operator:*'],
      ...common,
    };
  }
  if (!ctx.isAuthenticated) {
    return {
      kind: 'anonymous',
      subject: 'anonymous',
      authenticatedBy: 'none',
      capabilities: [],
      ...common,
    };
  }
  return {
    kind: 'authenticated',
    subject: SHARED_ACCESS_SUBJECT,
    authenticatedBy: 'access_token',
    capabilities: [],
    ...common,
  };
}

export function getOperatorPrincipal(req: FastifyRequest): OperatorPrincipal {
  const principal = getMessagePrincipal(req);
  if (principal.kind !== 'operator') {
    throw new Error('operator principal required');
  }
  return principal;
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

function validateAccessToken(req: FastifyRequest, configuredToken: string | undefined): boolean {
  if (!configuredToken) return false;
  const headerToken = normalizeHeader(req.headers['x-los-auth-token']);
  const authorization = normalizeHeader(req.headers.authorization);
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return validateToken(headerToken ?? bearer, configuredToken);
}

function validateToken(provided: string | undefined, configuredToken: string): boolean {
  if (!provided) return false;
  const actual = Buffer.from(provided);
  const expected = Buffer.from(configuredToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Extract and verify JWT from Authorization: Bearer header. */
function resolveJwtPayload(req: FastifyRequest): JwtPayload | null {
  const authHeader = req.headers.authorization;
  const authValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!authValue || typeof authValue !== 'string') return null;
  const match = authValue.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1];
  if (!token) return null;
  // Only treat as JWT if it has 3 dot-separated parts (JWT format)
  if (token.split('.').length !== 3) return null;
  return verifyJwt(token, getJwtSecret());
}
