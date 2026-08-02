import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  cancelPairwiseSampleGate, evaluatePairwiseSampleGate, listPairwiseSampleGates,
  loadPairwiseSampleGate, registerPairwiseSampleGate,
  type SampleGateRegistration, type SampleGateStatus,
} from '@los/agent';
import { asRecord } from '../server-helpers.js';
import { getRequestContext, requireOperator } from '../../request-context.js';

type SampleGateRouteDependencies = {
  cancelPairwiseSampleGate: typeof cancelPairwiseSampleGate;
  evaluatePairwiseSampleGate: typeof evaluatePairwiseSampleGate;
  listPairwiseSampleGates: typeof listPairwiseSampleGates;
  loadPairwiseSampleGate: typeof loadPairwiseSampleGate;
  registerPairwiseSampleGate: typeof registerPairwiseSampleGate;
  requireOperator: typeof requireOperator;
};

const defaultDependencies: SampleGateRouteDependencies = {
  cancelPairwiseSampleGate,
  evaluatePairwiseSampleGate,
  listPairwiseSampleGates,
  loadPairwiseSampleGate,
  registerPairwiseSampleGate,
  requireOperator,
};

function requestScope(req: FastifyRequest) {
  const context = getRequestContext(req);
  return { tenantId: context.tenantId, projectId: context.projectId };
}

async function handleRegisterSampleGate(
  req: FastifyRequest,
  reply: FastifyReply,
  dependencies: SampleGateRouteDependencies,
) {
  if (!(await dependencies.requireOperator(req, reply))) return;
  const body = asRecord(req.body);
  const scope = requestScope(req);
  try {
    const registration = await dependencies.registerPairwiseSampleGate({
      id: typeof body.id === 'string' ? body.id : undefined,
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      minimumPairs: Number(body.minimumPairs),
      scenarios: Array.isArray(body.scenarios) ? body.scenarios as SampleGateRegistration['scenarios'] : [],
      baselineRef: asRecord(body.baselineRef) as unknown as SampleGateRegistration['baselineRef'],
      candidateRef: asRecord(body.candidateRef) as unknown as SampleGateRegistration['candidateRef'],
      rubricRef: asRecord(body.rubricRef) as unknown as SampleGateRegistration['rubricRef'],
      registeredBy: getRequestContext(req).userId,
    });
    reply.status(201);
    return { sampleGate: registration };
  } catch (err) {
    return reply.status(422).send({ error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleListSampleGates(
  req: FastifyRequest,
  reply: FastifyReply,
  dependencies: SampleGateRouteDependencies,
) {
  const status = (req.query as { status?: string }).status as SampleGateStatus | undefined;
  const gates = await dependencies.listPairwiseSampleGates(requestScope(req), status);
  return { sampleGates: gates };
}

async function handleGetSampleGate(
  req: FastifyRequest,
  reply: FastifyReply,
  dependencies: SampleGateRouteDependencies,
) {
  const id = (req.params as { id: string }).id;
  const registration = await dependencies.loadPairwiseSampleGate(id, requestScope(req));
  return registration
    ? { sampleGate: registration }
    : reply.status(404).send({ error: 'Pairwise sample gate not found' });
}

async function handleCancelSampleGate(
  req: FastifyRequest,
  reply: FastifyReply,
  dependencies: SampleGateRouteDependencies,
) {
  if (!(await dependencies.requireOperator(req, reply))) return;
  const id = (req.params as { id: string }).id;
  try {
    const registration = await dependencies.cancelPairwiseSampleGate(
      id,
      requestScope(req),
      getRequestContext(req).userId,
    );
    return { sampleGate: registration };
  } catch (err) {
    return reply.status(409).send({ error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleEvaluateSampleGate(
  req: FastifyRequest,
  reply: FastifyReply,
  dependencies: SampleGateRouteDependencies,
) {
  if (!(await dependencies.requireOperator(req, reply))) return;
  const id = (req.params as { id: string }).id;
  try {
    const evaluation = await dependencies.evaluatePairwiseSampleGate(id, requestScope(req));
    return { evaluation };
  } catch (err) {
    return reply.status(404).send({ error: err instanceof Error ? err.message : String(err) });
  }
}

export function registerPairwiseSampleGateRoutes(
  app: FastifyInstance,
  overrides: Partial<SampleGateRouteDependencies> = {},
): void {
  const dependencies = { ...defaultDependencies, ...overrides };
  app.post('/pairwise-sample-gates', (req, reply) => handleRegisterSampleGate(req, reply, dependencies));
  app.get('/pairwise-sample-gates', (req, reply) => handleListSampleGates(req, reply, dependencies));
  app.get('/pairwise-sample-gates/:id', (req, reply) => handleGetSampleGate(req, reply, dependencies));
  app.post('/pairwise-sample-gates/:id/cancel', (req, reply) => handleCancelSampleGate(req, reply, dependencies));
  app.post('/pairwise-sample-gates/:id/evaluate', (req, reply) => handleEvaluateSampleGate(req, reply, dependencies));
}
