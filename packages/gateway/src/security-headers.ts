/**
 * Security headers middleware for the gateway.
 *
 * Adds:
 *  - X-Content-Type-Options: nosniff
 *  - X-Frame-Options: DENY
 *  - Referrer-Policy: strict-origin-when-cross-origin
 *  - Strict-Transport-Security: max-age=63072000 (opt-in via config, disabled for local dev)
 *  - Content-Security-Policy: opt-in, can be tightened per deployment
 *
 * Uses an onRequest hook (no external dependency required).
 * For a more complete header set with helmet, see ADR discussion.
 */

import type { FastifyInstance } from 'fastify';

export interface SecurityHeadersOptions {
  /** Enable HSTS header. Default: false (opt-in for HTTPS deployments). */
  hsts?: boolean;
  /** Custom CSP value. Omitted by default because the legacy fallback UI uses inline assets. */
  contentSecurityPolicy?: string;
}

export function registerSecurityHeaders(
  app: FastifyInstance,
  opts: SecurityHeadersOptions = {},
): void {
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (opts.contentSecurityPolicy) {
      reply.header('Content-Security-Policy', opts.contentSecurityPolicy);
    }

    if (opts.hsts) {
      reply.header(
        'Strict-Transport-Security',
        'max-age=63072000; includeSubDomains',
      );
    }
  });
}
