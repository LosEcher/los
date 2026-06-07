import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Config } from '@los/infra/config';

const PUBLIC_PATHS = ['/health', '/onboarding'];

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

    if (PUBLIC_PATHS.some(p => req.url === p || req.url?.startsWith(p))) return;

    const token = req.headers['x-los-auth-token'];
    const normalized = Array.isArray(token) ? token[0] : token;

    if (!config.auth.token || normalized !== config.auth.token) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });
}
