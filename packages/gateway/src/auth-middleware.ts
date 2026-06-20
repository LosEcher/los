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

    const token = req.headers['x-los-auth-token'];
    const normalized = Array.isArray(token) ? token[0] : token;

    if (!config.auth.token || normalized !== config.auth.token) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });
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
