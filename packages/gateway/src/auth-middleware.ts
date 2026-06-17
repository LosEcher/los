import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Config } from '@los/infra/config';

/**
 * Paths that never require auth.
 *
 * EXACT_PUBLIC_PATHS — only the exact URL matches (prevents '/' from
 * matching everything via startsWith).
 * PREFIX_PUBLIC_PATHS — any URL starting with this prefix is public.
 */
const EXACT_PUBLIC_PATHS = ['/', '/favicon.ico', '/settings'];
const PREFIX_PUBLIC_PATHS = ['/health', '/onboarding', '/api/integrations', '/assets/', '/nodes/heartbeat'];

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

    if (isPublicPath(req.url)) return;

    const token = req.headers['x-los-auth-token'];
    const normalized = Array.isArray(token) ? token[0] : token;

    if (!config.auth.token || normalized !== config.auth.token) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });
}

function isPublicPath(url: string | undefined): boolean {
  if (!url) return false;
  if (EXACT_PUBLIC_PATHS.includes(url)) return true;
  if (PREFIX_PUBLIC_PATHS.some(p => url.startsWith(p))) return true;
  // Also allow static assets with cache-busting hashes (e.g. /assets/index-abc123.js)
  if (url.startsWith('/assets/')) return true;
  return false;
}
