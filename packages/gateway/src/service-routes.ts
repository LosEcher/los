import type { FastifyInstance } from 'fastify';
import { getDb } from '@los/infra/db';
import {
  ensureServiceInstanceStore,
  listServiceInstances,
  loadServiceInstance,
  upsertServiceInstance,
  type ServiceInstanceRecord,
} from '@los/agent/service-instances';

type ServiceRoutesOptions = {
  serviceId: string;
  serviceKind?: string;
};

export function registerServiceRoutes(app: FastifyInstance, options: ServiceRoutesOptions): void {
  app.get('/live', async () => ({
    status: 'ok',
    serviceId: options.serviceId,
    serviceKind: options.serviceKind ?? 'gateway',
    uptime: process.uptime(),
  }));

  app.get('/ready', async (_req, reply) => {
    const readiness = await getCurrentReadiness(options.serviceId);
    if (!readiness.ready) {
      return reply.status(503).send(readiness);
    }
    return readiness;
  });

  app.get('/services', async () => {
    await ensureServiceInstanceStore();
    return await listServiceInstances();
  });

  app.get('/services/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const service = await loadServiceInstance(id);
    if (!service) return reply.status(404).send({ error: 'service instance not found' });
    return service;
  });

  app.post('/services/:id/drain', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { reason?: string } | undefined;
    const existing = await loadServiceInstance(id);
    if (!existing) return reply.status(404).send({ error: 'service instance not found' });
    const service = await upsertServiceInstance({
      serviceId: id,
      status: 'draining',
      rolloutState: 'draining',
      rolloutMessage: normalizeOptionalString(body?.reason) ?? 'drain requested',
    });
    return { ok: true, service };
  });

  app.post('/services/:id/promote', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { reason?: string } | undefined;
    const existing = await loadServiceInstance(id);
    if (!existing) return reply.status(404).send({ error: 'service instance not found' });
    const service = await upsertServiceInstance({
      serviceId: id,
      status: 'online',
      rolloutState: 'idle',
      rolloutMessage: normalizeOptionalString(body?.reason) ?? 'promoted',
    });
    return { ok: true, service };
  });
}

async function getCurrentReadiness(serviceId: string): Promise<{
  ready: boolean;
  serviceId: string;
  service?: ServiceInstanceRecord;
  checks: Record<string, unknown>;
  blockers: string[];
  warnings: string[];
}> {
  await ensureServiceInstanceStore();
  const service = await loadServiceInstance(serviceId);
  const checks: Record<string, unknown> = {
    db: false,
    registered: Boolean(service),
  };
  const blockers = [...(service?.readiness.blockers ?? ['service:not_registered'])];
  const warnings = [...(service?.readiness.warnings ?? [])];

  try {
    await getDb().query('select 1');
    checks.db = true;
  } catch (error) {
    checks.db = errorMessage(error);
    blockers.push('db:unavailable');
  }

  return {
    ready: blockers.length === 0,
    serviceId,
    service: service ?? undefined,
    checks,
    blockers,
    warnings,
  };
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
