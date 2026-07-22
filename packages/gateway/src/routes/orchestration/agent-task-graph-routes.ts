import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  cancelGovernedAgentTaskGraph,
  cancelScheduledTask,
  canStartExecution,
  createGovernedAgentTaskGraph,
  getAgentTaskGraphCompletion,
  integrateGovernedAgentTaskGraph,
  loadGovernedAgentTaskGraph,
  loadRunSpec,
  readAgentTaskGraph,
  requestCancellation,
  runAgentTaskGraphSerial,
} from '@los/agent';
import { getConfig } from '@los/infra/config';
import { asRecord, normalizeOptionalString, normalizeStringArray } from '../server-helpers.js';
import { getRequestContext, requireOperator } from '../../request-context.js';

export function registerAgentTaskGraphRoutes(app: FastifyInstance): void {
  app.post('/agent-graphs', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const body = asRecord(req.body);
    const runSpecId = normalizeOptionalString(body.runSpecId);
    const integrationOwner = normalizeOptionalString(body.integrationOwner);
    if (!runSpecId || !integrationOwner) {
      return reply.status(422).send({ error: 'runSpecId and integrationOwner are required' });
    }
    const runSpec = await loadRunSpec(runSpecId);
    if (!runSpec) return reply.status(404).send({ error: 'run spec not found' });
    const executionGate = canStartExecution(runSpec.runContract);
    if (!executionGate.allowed || !runSpec.runContract?.plan?.length) {
      return reply.status(409).send({ error: executionGate.reason ?? 'persisted approved plan is required (AP2)' });
    }
    try {
      const graphId = normalizeOptionalString(body.graphId) ?? `graph-${randomUUID()}`;
      const workers = normalizeWorkers(body.workers, graphId);
      const verifier = normalizeVerifier(body.verifier, graphId);
      const control = await createGovernedAgentTaskGraph({
        graphId,
        runSpecId,
        sessionId: runSpec.sessionId,
        integrationOwner,
        createdBy: getRequestContext(req).userId,
        workers,
        verifier,
        maxParallelTasks: normalizeInteger(body.maxParallelTasks),
      });
      return reply.status(201).send({
        graph: await readAgentTaskGraph(graphId, { requireVerifier: true }),
        control,
      });
    } catch (error) {
      return reply.status(422).send({ error: errorMessage(error) });
    }
  });

  app.get('/agent-graphs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as { requireVerifier?: string };
    const graph = await readAgentTaskGraph(id, {
      requireVerifier: normalizeBoolean(query.requireVerifier),
    });
    return { ...graph, control: await loadGovernedAgentTaskGraph(id) };
  });

  app.get('/agent-graphs/:id/watch', async (req) => {
    const { id } = req.params as { id: string };
    const graph = await readAgentTaskGraph(id, { requireVerifier: true });
    return { ...graph, control: await loadGovernedAgentTaskGraph(id) };
  });

  app.post('/agent-graphs/:id/run', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const { id } = req.params as { id: string };
    const control = await loadGovernedAgentTaskGraph(id);
    if (!control) return reply.status(404).send({ error: 'agent task graph not found' });
    if (control.status !== 'active') return reply.status(409).send({ error: `graph is ${control.status}` });
    const runSpecId = normalizeOptionalString(control.metadata.runSpecId);
    const runSpec = runSpecId ? await loadRunSpec(runSpecId) : null;
    if (!runSpec) return reply.status(409).send({ error: 'graph run spec is unavailable' });
    const executionGate = canStartExecution(runSpec.runContract);
    if (!executionGate.allowed) return reply.status(409).send({ error: executionGate.reason });
    const config = getConfig();
    try {
      const result = await runAgentTaskGraphSerial({
        graphId: id,
        runSpecId: runSpec.id,
        sessionId: runSpec.sessionId,
        tenantId: runSpec.tenantId,
        projectId: runSpec.projectId,
        userId: runSpec.userId,
        requestId: getRequestContext(req).requestId,
        traceId: runSpec.traceId,
        provider: runSpec.provider,
        model: runSpec.model,
        modelSettings: runSpec.modelSettings,
        workspaceRoot: runSpec.workspaceRoot,
        toolMode: runSpec.toolMode as 'all' | 'project-write' | 'read-only',
        allowedTools: runSpec.allowedTools,
        toolRetry: runSpec.toolRetry,
        maxLoops: runSpec.maxLoops,
        timeoutMs: runSpec.timeoutMs,
        mcpServers: runSpec.mcpServers,
        runContract: runSpec.runContract,
        maxParallelTasks: normalizeInteger(control.metadata.maxParallelTasks) ?? 2,
        editableSurfaceMode: 'require-declared',
        requireVerifier: true,
        executor: {
          enabled: config.executor.enabled,
          nodeUrls: config.executor.meshNodes,
          agentKey: config.executor.agentKey,
          nodeId: config.executor.nodeId,
        },
        onTaskEvent: () => undefined,
      });
      return {
        result,
        graph: await readAgentTaskGraph(id, { requireVerifier: true }),
        control: await loadGovernedAgentTaskGraph(id),
      };
    } catch (error) {
      return reply.status(422).send({ error: errorMessage(error) });
    }
  });

  app.get('/agent-graphs/:id/completion', async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as { requireVerifier?: string };
    return await getAgentTaskGraphCompletion(id, {
      requireVerifier: normalizeBoolean(query.requireVerifier),
    });
  });

  app.post('/agent-graphs/:id/cancel', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const { id } = req.params as { id: string };
    const reason = normalizeOptionalString(asRecord(req.body).reason) ?? 'cancelled_by_operator';
    const graph = await readAgentTaskGraph(id);
    for (const attempts of Object.values(graph.attemptsByTaskId)) {
      for (const attempt of attempts) {
        if (!attempt.taskRunId || attempt.status !== 'running') continue;
        cancelScheduledTask(attempt.taskRunId, reason);
        await requestCancellation(attempt.taskRunId, reason, 'agent_graph_api').catch(() => undefined);
      }
    }
    try {
      const control = await cancelGovernedAgentTaskGraph(id, getRequestContext(req).userId, reason);
      if (!control) return reply.status(404).send({ error: 'agent task graph not found' });
      return { graph: await readAgentTaskGraph(id, { requireVerifier: true }), control };
    } catch (error) {
      return reply.status(409).send({ error: errorMessage(error) });
    }
  });

  app.post('/agent-graphs/:id/integrate', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const { id } = req.params as { id: string };
    try {
      const control = await integrateGovernedAgentTaskGraph(
        id,
        getRequestContext(req).userId,
        normalizeOptionalString(asRecord(req.body).note),
      );
      if (!control) return reply.status(404).send({ error: 'agent task graph not found' });
      return { graph: await readAgentTaskGraph(id, { requireVerifier: true }), control };
    } catch (error) {
      return reply.status(409).send({ error: errorMessage(error) });
    }
  });
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

function normalizeWorkers(value: unknown, graphId: string) {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const worker = asRecord(item);
    return {
      id: normalizeOptionalString(worker.id) ?? `${graphId}-worker-${index + 1}`,
      title: normalizeOptionalString(worker.title) ?? '',
      prompt: normalizeOptionalString(worker.prompt),
      editableSurfaces: normalizeStringArray(worker.editableSurfaces),
      priority: normalizeInteger(worker.priority),
      maxAttempts: normalizeInteger(worker.maxAttempts),
    };
  });
}

function normalizeVerifier(value: unknown, graphId: string) {
  const verifier = asRecord(value);
  return {
    id: normalizeOptionalString(verifier.id) ?? `${graphId}-verifier`,
    title: normalizeOptionalString(verifier.title) ?? 'Verify graph output',
    prompt: normalizeOptionalString(verifier.prompt),
    priority: normalizeInteger(verifier.priority),
    maxAttempts: normalizeInteger(verifier.maxAttempts),
  };
}

function normalizeInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
