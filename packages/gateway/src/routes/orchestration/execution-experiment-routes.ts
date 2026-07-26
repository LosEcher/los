import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  approveExecutionExperiment, createExecutionExperiment, loadExecutionExperiment,
  setExecutionExperimentCandidate, transitionExecutionExperiment,
  runScheduledAgentTask, loadRunSpec, createRunSpec, approveRunSpecPhase,
  type ExecutionExperimentConfigDiff,
} from '@los/agent';
import { transitionExecutionState } from '@los/agent/execution-store';
import { getConfig } from '@los/infra/config';
import { asRecord, normalizeOptionalString, normalizeBoundedInteger } from '../server-helpers.js';
import { getRequestContext, requireOperator } from '../../request-context.js';
import { applyDirectRunCompletionStatus } from '../../chat-run-completion.js';
import { runIdempotentJson } from '../../idempotency.js';

const ALLOWED_DIFF_PATHS = new Set(['provider', 'model', 'toolMode', 'allowedTools', 'maxLoops', 'timeoutMs', 'modelSettings']);
const ALLOWED_TOOL_MODES = new Set(['all', 'project-write', 'read-only']);

type ExecutionExperimentRouteDependencies = {
  approveRunSpecPhase: typeof approveRunSpecPhase;
  applyDirectRunCompletionStatus: typeof applyDirectRunCompletionStatus;
  createExecutionExperiment: typeof createExecutionExperiment;
  createRunSpec: typeof createRunSpec;
  loadExecutionExperiment: typeof loadExecutionExperiment;
  loadRunSpec: typeof loadRunSpec;
  approveExecutionExperiment: typeof approveExecutionExperiment;
  requireOperator: typeof requireOperator;
  runIdempotentJson: typeof runIdempotentJson;
  runScheduledAgentTask: typeof runScheduledAgentTask;
  setExecutionExperimentCandidate: typeof setExecutionExperimentCandidate;
  transitionExecutionExperiment: typeof transitionExecutionExperiment;
  transitionExecutionState: typeof transitionExecutionState;
};

const defaultDependencies: ExecutionExperimentRouteDependencies = {
  approveRunSpecPhase,
  applyDirectRunCompletionStatus,
  createExecutionExperiment,
  createRunSpec,
  loadExecutionExperiment,
  loadRunSpec,
  approveExecutionExperiment,
  requireOperator,
  runIdempotentJson,
  runScheduledAgentTask,
  setExecutionExperimentCandidate,
  transitionExecutionExperiment,
  transitionExecutionState,
};

export function registerExecutionExperimentRoutes(
  app: FastifyInstance,
  overrides: Partial<ExecutionExperimentRouteDependencies> = {},
): void {
  const dependencies = { ...defaultDependencies, ...overrides };
  app.post('/execution-experiments', async (req, reply) => {
    const body = asRecord(req.body);
    const source = asRecord(body.source);
    if (!source.sessionId || !source.runSpecId || source.eventCursor === undefined || !source.evidenceHash) {
      return reply.status(422).send({ error: 'source.sessionId, source.runSpecId, source.eventCursor, and source.evidenceHash are required' });
    }
    try {
      const context = getRequestContext(req);
      const configDiff = parseConfigDiff(body.configDiff);
      reply.status(201);
      return await dependencies.runIdempotentJson(
        req,
        reply,
        { route: '/execution-experiments', method: 'POST', body, context },
        async () => ({
          experiment: await dependencies.createExecutionExperiment({
            id: normalizeOptionalString(body.id) ?? `experiment-${randomUUID()}`,
            tenantId: context.tenantId,
            projectId: context.projectId,
            source: {
              sessionId: String(source.sessionId), runSpecId: String(source.runSpecId),
              eventCursor: normalizeBoundedInteger(source.eventCursor, 0, 0, Number.MAX_SAFE_INTEGER),
              evidenceHash: String(source.evidenceHash),
              fingerprint: asRecord(source.fingerprint) as any,
            },
            configDiff,
            createdBy: context.userId,
          }),
        }),
      );
    } catch (err) {
      return reply.status(422).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/execution-experiments/:id', async (req, reply) => {
    const context = getRequestContext(req);
    const record = await dependencies.loadExecutionExperiment(
      (req.params as { id: string }).id,
      { tenantId: context.tenantId, projectId: context.projectId },
    );
    return record ? { experiment: record } : reply.status(404).send({ error: 'Execution experiment not found' });
  });

  app.post('/execution-experiments/:id/approve', async (req, reply) => {
    if (!(await dependencies.requireOperator(req, reply))) return;
    try {
      const context = getRequestContext(req);
      const record = await dependencies.approveExecutionExperiment(
        (req.params as { id: string }).id,
        context.userId,
        { tenantId: context.tenantId, projectId: context.projectId },
      );
      return { experiment: record };
    } catch (err) {
      return reply.status(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/execution-experiments/:id/execute', async (req, reply) => {
    if (!(await dependencies.requireOperator(req, reply))) return;
    const id = (req.params as { id: string }).id;
    const context = getRequestContext(req);
    const scope = { tenantId: context.tenantId, projectId: context.projectId };
    const experiment = await dependencies.loadExecutionExperiment(id, scope);
    if (!experiment) return reply.status(404).send({ error: 'Execution experiment not found' });
    if (experiment.status !== 'approved') return reply.status(409).send({ error: `experiment must be approved before execution (status=${experiment.status})` });
    try {
      const source = await dependencies.loadRunSpec(experiment.source.runSpecId);
      if (!source || !matchesExperimentScope(source, experiment)) {
        return reply.status(422).send({ error: 'source run spec not found in experiment scope' });
      }
      if (!source.runContract?.plan?.length) return reply.status(422).send({ error: 'source run spec has no persisted plan; AP2 blocks execution' });
      const config = getConfig();
      const candidateId = experiment.candidateRunSpecId ?? `run-${id}-candidate`;
      if (!experiment.candidateRunSpecId) {
        const candidate = applyDiffToRunSpec(source, experiment.configDiff);
        await dependencies.createRunSpec({
          id: candidateId,
          sessionId: `${experiment.source.sessionId}:experiment:${id}`,
          tenantId: experiment.tenantId, projectId: experiment.projectId,
          userId: getRequestContext(req).userId, requestId: getRequestContext(req).requestId,
          traceId: getRequestContext(req).traceId, prompt: source.prompt,
          systemPrompt: source.systemPrompt, provider: candidate.provider, model: candidate.model,
          modelSettings: candidate.modelSettings, workspaceRoot: candidate.workspaceRoot,
          toolMode: candidate.toolMode, allowedTools: candidate.allowedTools, toolRetry: candidate.toolRetry,
          maxLoops: candidate.maxLoops, timeoutMs: candidate.timeoutMs, mcpServers: candidate.mcpServers,
          runContract: { ...source.runContract, phase: 'planning', previousPhase: 'created', phaseChangedAt: new Date().toISOString() },
        });
        await dependencies.setExecutionExperimentCandidate(id, candidateId, scope);
      }
      let current = await dependencies.loadRunSpec(candidateId);
      if (!current || !matchesExperimentScope(current, experiment)) {
        throw new Error('candidate run spec was not created in experiment scope');
      }
      if (current.runContract?.phase === 'planning') {
        await dependencies.approveRunSpecPhase(candidateId, {
          actor: context.userId,
          reason: `execution experiment ${id} approved candidate`,
        });
        current = await dependencies.loadRunSpec(candidateId);
        if (!current || !matchesExperimentScope(current, experiment)) {
          throw new Error('candidate run spec disappeared from experiment scope after approval');
        }
      }
      if (current.runContract?.phase !== 'plan_approved') {
        throw new Error(`candidate run spec must be plan_approved before execution (phase=${current.runContract?.phase ?? 'missing'})`);
      }
      await dependencies.transitionExecutionState({ entityType: 'run_spec', entityId: candidateId, to: 'running', sessionId: current.sessionId, reason: 'execution_experiment_started' });
      await dependencies.transitionExecutionExperiment(id, 'running', 'execution_experiment_started', scope);
      const result = await dependencies.runScheduledAgentTask({
        prompt: current.prompt, sessionId: current.sessionId, runSpecId: current.id, provider: current.provider,
        model: current.model, systemPrompt: current.systemPrompt, workspaceRoot: current.workspaceRoot,
        toolMode: current.toolMode as 'all' | 'project-write' | 'read-only', allowedTools: current.allowedTools,
        maxLoops: current.maxLoops, timeoutMs: current.timeoutMs, toolRetry: current.toolRetry,
        mcpServers: current.mcpServers, traceId: current.traceId, requestId: current.requestId,
        tenantId: current.tenantId, projectId: current.projectId, userId: current.userId,
        runContract: current.runContract, executor: { enabled: config.executor.enabled, nodeUrls: config.executor.meshNodes, agentKey: config.executor.agentKey, nodeId: config.executor.nodeId },
        onTaskEvent: () => undefined,
      });
      const completion = await dependencies.applyDirectRunCompletionStatus({ runSpecId: candidateId, sessionId: current.sessionId, tenantId: current.tenantId, projectId: current.projectId, userId: current.userId, requestId: current.requestId, traceId: current.traceId, taskRunId: result.taskRun.id });
      const final = completion.status === 'succeeded'
        ? await dependencies.transitionExecutionExperiment(id, 'succeeded', 'candidate_run_completed', scope)
        : await dependencies.transitionExecutionExperiment(id, 'blocked', 'candidate_verification_blocked', scope);
      return { experiment: final, candidateRunSpecId: candidateId, completion };
    } catch (err) {
      await dependencies.transitionExecutionExperiment(id, 'failed', 'candidate_execution_failed', scope).catch(() => undefined);
      return reply.status(422).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

function matchesExperimentScope(
  runSpec: Pick<NonNullable<Awaited<ReturnType<typeof loadRunSpec>>>, 'tenantId' | 'projectId'>,
  experiment: Pick<Awaited<ReturnType<typeof loadExecutionExperiment>> & {}, 'tenantId' | 'projectId'>,
): boolean {
  return runSpec.tenantId === experiment.tenantId && runSpec.projectId === experiment.projectId;
}

function parseConfigDiff(value: unknown): ExecutionExperimentConfigDiff[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = asRecord(item);
    const path = normalizeOptionalString(row.path);
    if (!path || !ALLOWED_DIFF_PATHS.has(path)) throw new Error(`configDiff path is not allowed: ${String(row.path)}`);
    if (path === 'maxLoops' || path === 'timeoutMs') {
      if (!Number.isSafeInteger(row.value) || Number(row.value) <= 0) {
        throw new Error(`configDiff ${path} must be a positive integer`);
      }
    }
    if (path === 'provider' || path === 'model') {
      if (typeof row.value !== 'string' || row.value.trim().length === 0) {
        throw new Error(`configDiff ${path} must be a non-empty string`);
      }
    }
    if (path === 'toolMode' && (typeof row.value !== 'string' || !ALLOWED_TOOL_MODES.has(row.value))) {
      throw new Error('configDiff toolMode must be all, project-write, or read-only');
    }
    if (path === 'allowedTools' && (
      !Array.isArray(row.value)
      || row.value.some(tool => typeof tool !== 'string' || tool.trim().length === 0)
    )) {
      throw new Error('configDiff allowedTools must be an array of non-empty strings');
    }
    if (path === 'modelSettings' && (
      row.value === null
      || typeof row.value !== 'object'
      || Array.isArray(row.value)
    )) {
      throw new Error('configDiff modelSettings must be an object');
    }
    return { path, value: row.value, inherited: row.inherited === true };
  });
}

function applyDiffToRunSpec(source: NonNullable<Awaited<ReturnType<typeof loadRunSpec>>>, diff: ExecutionExperimentConfigDiff[]) {
  const result = {
    provider: source.provider, model: source.model, modelSettings: { ...source.modelSettings },
    workspaceRoot: source.workspaceRoot, toolMode: source.toolMode, allowedTools: [...source.allowedTools],
    toolRetry: { ...source.toolRetry }, maxLoops: source.maxLoops, timeoutMs: source.timeoutMs, mcpServers: source.mcpServers,
  };
  for (const item of diff) {
    if (item.path === 'modelSettings') result.modelSettings = asRecord(item.value);
    else if (item.path === 'allowedTools' && Array.isArray(item.value)) result.allowedTools = item.value.filter((value): value is string => typeof value === 'string');
    else if (item.path === 'provider' || item.path === 'model' || item.path === 'toolMode') (result as any)[item.path] = String(item.value);
    else if (item.path === 'maxLoops' || item.path === 'timeoutMs') (result as any)[item.path] = Number(item.value);
  }
  return result;
}
