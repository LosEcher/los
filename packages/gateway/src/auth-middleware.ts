import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Config } from '@los/infra/config';
import { verifyJwt, getJwtSecret } from './auth-store.js';

/**
 * Paths that never require auth.
 */
const EXACT_PUBLIC_PATHS = ['/', '/favicon.ico'];
const PREFIX_PUBLIC_PATHS = ['/health', '/onboarding', '/api/integrations', '/assets/', '/auth/login', '/auth/register', '/auth/status'];

/** Paths that are public only for specific HTTP methods. */
const METHOD_PUBLIC_PATHS: Record<string, Set<string>> = {
  '/settings': new Set(['GET', 'HEAD', 'OPTIONS']),
};

export interface AuthMiddlewareOptions {
  config: Config;
}

export default async function authMiddleware(
  app: FastifyInstance,
  opts: AuthMiddlewareOptions,
): Promise<void> {
  const { config } = opts;

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // Executor heartbeats are a control-plane write, even when user auth is
    // disabled for local development. When a shared executor key is configured
    // it is the only credential accepted for this route.
    if (isExecutorHeartbeatPath(req.url, req.method) && config.executor.agentKey) {
      const bearer = extractBearerToken(req);
      if (bearer && bearer === config.executor.agentKey) return;
      return reply.code(401).send({ error: 'executor heartbeat authentication required' });
    }

    if (!config.auth.enabled) return;

    if (isPublicPath(req.url, req.method)) return;

    // 1. Operator token (strongest auth path): x-los-operator-token header
    if (config.auth.operatorToken) {
      const opToken = req.headers['x-los-operator-token'];
      const opNormalized = Array.isArray(opToken) ? opToken[0] : opToken;
      if (opNormalized === config.auth.operatorToken) return;
    }

    // 2. JWT Bearer token (user login)
    const bearerToken = extractBearerToken(req);
    if (bearerToken) {
      const payload = verifyJwt(bearerToken, getJwtSecret());
      if (payload) return; // Valid JWT → authenticated
    }

    // 3. Static auth token (legacy backward compatibility)
    const staticToken = extractAuthToken(req);
    if (config.auth.token && staticToken === config.auth.token) return;

    return reply.code(401).send({ error: 'unauthorized' });
  });
}

/** Extract Bearer token from Authorization header (JWT). */
function extractBearerToken(req: FastifyRequest): string | undefined {
  const authorization = req.headers.authorization;
  const authValue = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof authValue !== 'string') return undefined;
  const match = authValue.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

/** Resolve auth token from los header or standard Bearer scheme (legacy static token). */
function extractAuthToken(req: FastifyRequest): string | undefined {
  const headerToken = req.headers['x-los-auth-token'];
  const fromHeader = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  if (typeof fromHeader === 'string' && fromHeader.trim()) return fromHeader.trim();

  // Only treat as static token if it doesn't look like a JWT (3 dot-separated parts)
  const bearer = extractBearerToken(req);
  if (bearer && !bearer.includes('.')) return bearer;

  return undefined;
}

function isPublicPath(url: string | undefined, method: string): boolean {
  if (!url) return false;
  if (EXACT_PUBLIC_PATHS.includes(url)) return true;
  const path = url.split('?')[0] || url;
  const methods = METHOD_PUBLIC_PATHS[path];
  if (methods && methods.has(method)) return true;
  if (PREFIX_PUBLIC_PATHS.some(p => path.startsWith(p))) return true;
  return false;
}

function isExecutorHeartbeatPath(url: string | undefined, method: string): boolean {
  if (method !== 'POST' || !url) return false;
  return (url.split('?')[0] || url) === '/nodes/heartbeat';
}
