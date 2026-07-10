import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Config } from '@los/infra/config';

/**
 * Paths that never require auth.
 */
const EXACT_PUBLIC_PATHS = ['/', '/favicon.ico'];
const PREFIX_PUBLIC_PATHS = ['/health', '/onboarding', '/api/integrations', '/assets/', '/nodes/heartbeat'];

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
    if (!config.auth.enabled) return;

    if (isPublicPath(req.url, req.method)) return;

    // Operator token (strongest auth path): x-los-operator-token header
    // When set, grants operator-level access for RunContract phase approvals,
    // session steering, and other operator-gated actions.
    if (config.auth.operatorToken) {
      const opToken = req.headers['x-los-operator-token'];
      const opNormalized = Array.isArray(opToken) ? opToken[0] : opToken;
      if (opNormalized === config.auth.operatorToken) return;
    }

    // Auth token: x-los-auth-token OR Authorization: Bearer <token>
    // Bearer is required for OpenAI-compatible clients (WeClaw HTTP agent,
    // curl -H "Authorization: Bearer …", etc.) which never set x-los-auth-token.
    const provided = extractAuthToken(req);
    if (!config.auth.token || provided !== config.auth.token) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });
}

/** Resolve auth token from los header or standard Bearer scheme. */
function extractAuthToken(req: FastifyRequest): string | undefined {
  const headerToken = req.headers['x-los-auth-token'];
  const fromHeader = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  if (typeof fromHeader === 'string' && fromHeader.trim()) return fromHeader.trim();

  const authorization = req.headers.authorization;
  const authValue = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof authValue !== 'string') return undefined;
  const match = authValue.match(/^Bearer\s+(.+)$/i);
  const bearer = match?.[1]?.trim();
  return bearer || undefined;
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
