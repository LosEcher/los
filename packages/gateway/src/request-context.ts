import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export interface RequestContext {
  requestId: string;
  traceId: string;
  tenantId: string;
  projectId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    requestContext: RequestContext;
  }
}

export function registerRequestContext(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const requestId = normalizeHeader(req.headers['x-request-id']) ?? `req-${randomUUID()}`;
    const traceId = normalizeHeader(req.headers['x-trace-id']) ?? requestId;
    const tenantId = normalizeHeader(req.headers['x-tenant-id']) ?? 'local';
    const projectId = normalizeHeader(req.headers['x-project-id']) ?? 'los';

    req.requestContext = {
      requestId,
      traceId,
      tenantId,
      projectId,
    };

    reply.header('x-request-id', requestId);
    reply.header('x-trace-id', traceId);
    reply.header('x-tenant-id', tenantId);
    reply.header('x-project-id', projectId);
  });
}

export function getRequestContext(req: FastifyRequest): RequestContext {
  const requestId = `req-${randomUUID()}`;
  return req.requestContext ?? {
    requestId,
    traceId: requestId,
    tenantId: 'local',
    projectId: 'los',
  };
}

function normalizeHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}
