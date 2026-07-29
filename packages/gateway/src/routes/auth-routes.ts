/**
 * Auth routes — user registration, login, current-user, logout.
 *
 * Registration policy:
 * - When no users exist (bootstrap): open registration for the first operator.
 * - After bootstrap: requires x-los-operator-token.
 *
 * All endpoints are public (unauthenticated by auth-middleware) except GET /auth/me.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Config } from '@los/infra/config';
import {
  createUser,
  authenticateUser,
  countUsers,
  verifyJwt,
  getJwtSecret,
  type JwtPayload,
} from '../auth-store.js';
import { getRequestContext } from '../request-context.js';
import { getLogger } from '@los/infra/logger';

const log = getLogger('auth-routes');

export async function registerAuthRoutes(app: FastifyInstance, _opts: { config: Config }): Promise<void> {

  // ── POST /auth/register ──────────────────────────────
  app.post('/auth/register', async (req: FastifyRequest, reply: FastifyReply) => {
    const { username, password, role } = req.body as {
      username?: string;
      password?: string;
      role?: 'operator' | 'user';
    };

    if (!username || typeof username !== 'string' || username.trim().length < 2) {
      return reply.code(400).send({ error: 'username must be at least 2 characters' });
    }
    if (!password || typeof password !== 'string' || password.length < 6) {
      return reply.code(400).send({ error: 'password must be at least 6 characters' });
    }

    const trimmedUsername = username.trim().toLowerCase();
    const userCount = await countUsers();

    // Bootstrap: first user is always operator (client role is ignored).
    // After bootstrap, only operators can create users; role still clamped.
    if (userCount > 0) {
      const ctx = getRequestContext(req);
      if (!ctx.isOperator) {
        return reply.code(403).send({ error: 'operator privilege required to create users' });
      }
    }

    const safeRole = userCount === 0
      ? 'operator'
      : (role === 'operator' ? 'operator' : 'user');

    try {
      const user = await createUser(trimmedUsername, password, safeRole);
      log.info(`User registered: ${user.username} (${user.role})`);
      return reply.code(201).send({
        id: user.id,
        username: user.username,
        role: user.role,
        createdAt: user.createdAt,
      });
    } catch (err: unknown) {
      const msg = (err as Error)?.message ?? String(err);
      if (msg.includes('unique') || msg.includes('duplicate')) {
        return reply.code(409).send({ error: 'username already exists' });
      }
      log.error(`Registration failed: ${msg}`);
      return reply.code(500).send({ error: 'registration failed' });
    }
  });

  // ── POST /auth/login ─────────────────────────────────
  app.post('/auth/login', async (req: FastifyRequest, reply: FastifyReply) => {
    const { username, password } = req.body as {
      username?: string;
      password?: string;
    };

    if (!username || !password) {
      return reply.code(400).send({ error: 'username and password are required' });
    }

    const result = await authenticateUser(username.trim().toLowerCase(), password);
    if (!result) {
      return reply.code(401).send({ error: 'invalid username or password' });
    }

    return reply.send({
      token: result.token,
      user: {
        id: result.user.id,
        username: result.user.username,
        role: result.user.role,
      },
    });
  });

  // ── GET /auth/me ─────────────────────────────────────
  app.get('/auth/me', async (req: FastifyRequest, reply: FastifyReply) => {
    // Extract JWT from Authorization header
    const authHeader = req.headers.authorization;
    const authValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (!authValue || typeof authValue !== 'string') {
      return reply.code(401).send({ error: 'not authenticated' });
    }
    const match = authValue.match(/^Bearer\s+(.+)$/i);
    const token = match?.[1];
    if (!token) {
      return reply.code(401).send({ error: 'not authenticated' });
    }

    const payload = verifyJwt(token, getJwtSecret());
    if (!payload) {
      return reply.code(401).send({ error: 'invalid or expired token' });
    }

    return reply.send({
      id: payload.sub,
      username: payload.username,
      role: payload.role,
    });
  });

  // ── GET /auth/status ─────────────────────────────────
  // Public: returns whether any users exist (for bootstrap UI)
  app.get('/auth/status', async (_req: FastifyRequest, reply: FastifyReply) => {
    const userCount = await countUsers();
    return reply.send({
      hasUsers: userCount > 0,
      userCount,
    });
  });
}
