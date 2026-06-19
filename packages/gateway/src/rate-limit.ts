/**
 * In-memory rate limiter for gateway routes.
 *
 * Uses a sliding-window counter per key (IP by default).
 * Zero external dependencies — Fastify-compatible onRequest hook.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';

export interface RateLimitOptions {
  /** Max requests allowed in the window (default: 30). */
  max: number;
  /** Window duration in milliseconds (default: 60_000). */
  windowMs: number;
  /** Key function — defaults to req.ip. */
  keyFn?: (req: FastifyRequest) => string;
  /** Custom error message (default: 'Too many requests'). */
  message?: string;
}

interface WindowEntry {
  count: number;
  resetAt: number;
}

export function createRateLimiter(opts: RateLimitOptions) {
  const max = opts.max;
  const windowMs = opts.windowMs;
  const keyFn = opts.keyFn ?? ((req: FastifyRequest) => req.ip);
  const message = opts.message ?? 'Too many requests';

  // In-memory store. For multi-process deployments, replace with Redis or
  // PostgreSQL advisory-lock based counter.
  const store = new Map<string, WindowEntry>();

  // Periodic cleanup of expired entries (every 5 minutes)
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) store.delete(key);
    }
  }, 300_000).unref();

  async function hook(req: FastifyRequest, reply: FastifyReply) {
    const key = keyFn(req);
    const now = Date.now();

    let entry = store.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 1, resetAt: now + windowMs };
      store.set(key, entry);
      return;
    }

    entry.count++;
    if (entry.count > max) {
      const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
      return reply
        .status(429)
        .header('Retry-After', String(retryAfterSec))
        .send({ error: message });
    }
  }

  return { hook, cleanupInterval };
}
