import type { FastifyInstance } from 'fastify';
import {
  ensureServiceInstanceStore,
  listServiceInstances,
  loadServiceInstance,
  upsertServiceInstance,
  type ServiceInstanceRecord,
} from '@los/agent/service-instances';

export type ServiceRoutesDependencies = {
  ensureServiceInstanceStore: typeof ensureServiceInstanceStore;
  listServiceInstances: typeof listServiceInstances;
  loadServiceInstance: typeof loadServiceInstance;
  upsertServiceInstance: typeof upsertServiceInstance;
};

const defaultDependencies: ServiceRoutesDependencies = {
  ensureServiceInstanceStore,
  listServiceInstances,
  loadServiceInstance,
  upsertServiceInstance,
};

type ServiceRoutesOptions = {
  serviceId: string;
  serviceKind?: string;
};

export function registerServiceRoutes(
  app: FastifyInstance,
  options: ServiceRoutesOptions,
  deps: ServiceRoutesDependencies = defaultDependencies,
): void {
  app.get('/live', async () => ({
    status: 'ok',
    serviceId: options.serviceId,
    serviceKind: options.serviceKind ?? 'gateway',
    uptime: process.uptime(),
  }));

  app.get('/ready', async (_req, reply) => {
    const readiness = await getCurrentReadiness(options.serviceId, deps);
    if (!readiness.ready) {
      return reply.status(503).send(readiness);
    }
    return readiness;
  });

  app.get('/services', async () => {
    await deps.ensureServiceInstanceStore();
    return await deps.listServiceInstances();
  });

  app.get('/services/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const service = await deps.loadServiceInstance(id);
    if (!service) return reply.status(404).send({ error: 'service instance not found' });
    return service;
  });

  app.post('/services/:id/drain', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { reason?: string } | undefined;
    const existing = await deps.loadServiceInstance(id);
    if (!existing) return reply.status(404).send({ error: 'service instance not found' });
    const service = await deps.upsertServiceInstance({
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
    const existing = await deps.loadServiceInstance(id);
    if (!existing) return reply.status(404).send({ error: 'service instance not found' });
    const service = await deps.upsertServiceInstance({
      serviceId: id,
      status: 'online',
      rolloutState: 'idle',
      rolloutMessage: normalizeOptionalString(body?.reason) ?? 'promoted',
    });
    return { ok: true, service };
  });
}

async function getCurrentReadiness(
  serviceId: string,
  deps: ServiceRoutesDependencies,
): Promise<{
  ready: boolean;
  serviceId: string;
  service?: ServiceInstanceRecord;
  checks: Record<string, unknown>;
  blockers: string[];
  warnings: string[];
}> {
  await deps.ensureServiceInstanceStore();
  const service = await deps.loadServiceInstance(serviceId);
  const checks: Record<string, unknown> = {
    registered: Boolean(service),
  };
  const blockers = [...(service?.readiness.blockers ?? ['service:not_registered'])];
  const warnings = [...(service?.readiness.warnings ?? [])];

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
