import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  approveExecutionExperiment, createExecutionExperiment, loadExecutionExperiment,
  setExecutionExperimentCandidate, transitionExecutionExperiment,
  runScheduledAgentTask, loadRunSpec, createRunSpec, approveRunSpecPhase,
  authorizeRunSpecKernelCanary, rollbackRunSpecExecutionKernel,
  createK4ExecutionKernelSelection, validateK4ExecutionKernelSelection,
} from '@los/agent';
import { transitionExecutionState } from '@los/agent/execution-store';
import { getConfig } from '@los/infra/config';
import { asRecord, normalizeOptionalString, normalizeBoundedInteger } from '../server-helpers.js';
import { getRequestContext, requireOperator } from '../../request-context.js';
import { applyDirectRunCompletionStatus } from '../../chat-run-completion.js';
import { runIdempotentJson } from '../../idempotency.js';
import {
  applyExecutionExperimentDiff,
  parseExecutionExperimentConfigDiff,
  readK4KernelCandidate,
} from './execution-experiment-config.js';

type ExecutionExperimentRouteDependencies = {
  approveRunSpecPhase: typeof approveRunSpecPhase;
  applyDirectRunCompletionStatus: typeof applyDirectRunCompletionStatus;
  createExecutionExperiment: typeof createExecutionExperiment;
  createRunSpec: typeof createRunSpec;
  loadExecutionExperiment: typeof loadExecutionExperiment;
  loadRunSpec: typeof loadRunSpec;
  approveExecutionExperiment: typeof approveExecutionExperiment;
  authorizeRunSpecKernelCanary: typeof authorizeRunSpecKernelCanary;
  requireOperator: typeof requireOperator;
  runIdempotentJson: typeof runIdempotentJson;
  runScheduledAgentTask: typeof runScheduledAgentTask;
  rollbackRunSpecExecutionKernel: typeof rollbackRunSpecExecutionKernel;
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
  authorizeRunSpecKernelCanary,
  requireOperator,
  runIdempotentJson,
  runScheduledAgentTask,
  rollbackRunSpecExecutionKernel,
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
      const configDiff = parseExecutionExperimentConfigDiff(body.configDiff);
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

  app.post('/execution-experiments/:id/select-candidate', async (req, reply) => {
    if (!(await dependencies.requireOperator(req, reply))) return;
    const id = (req.params as { id: string }).id;
    const context = getRequestContext(req);
    const scope = { tenantId: context.tenantId, projectId: context.projectId };
    try {
      const experiment = await dependencies.loadExecutionExperiment(id, scope);
      if (!experiment) return reply.status(404).send({ error: 'Execution experiment not found' });
      if (experiment.status !== 'draft') {
        return reply.status(409).send({ error: `candidate must be selected while experiment is draft (status=${experiment.status})` });
      }
      const candidatePolicy = readK4KernelCandidate(experiment.configDiff);
      if (!candidatePolicy) return reply.status(422).send({ error: 'executionKernel configDiff is required for K4 candidate selection' });
      const candidateId = experiment.candidateRunSpecId ?? `run-${id}-candidate`;
      if (experiment.candidateRunSpecId) {
        const existing = await dependencies.loadRunSpec(candidateId);
        if (!existing || !matchesExperimentScope(existing, experiment)) {
          throw new Error('persisted candidate run spec is missing from experiment scope');
        }
        return { experiment, candidateRunSpec: existing };
      }
      const source = await dependencies.loadRunSpec(experiment.source.runSpecId);
      if (!source || !matchesExperimentScope(source, experiment)) {
        return reply.status(422).send({ error: 'source run spec not found in experiment scope' });
      }
      if (!source.runContract?.plan?.length) {
        return reply.status(422).send({ error: 'source run spec has no persisted plan; AP2 blocks candidate selection' });
      }
      const recovered = await dependencies.loadRunSpec(candidateId);
      if (recovered) {
        const policyError = validateK4ExecutionKernelSelection(recovered.runContract?.executionKernel, {
          runContractMode: recovered.runContract?.mode,
          toolMode: recovered.toolMode,
          executorEnabled: false,
          requireCanaryAuthorization: false,
        });
        if (!matchesExperimentScope(recovered, experiment)
          || recovered.runContract?.executionKernel?.experimentId !== id
          || recovered.runContract.executionKernel.disposition !== candidatePolicy.disposition
          || recovered.runContract.planParentRunSpecId !== source.id
          || policyError) {
          throw new Error(`candidate run spec id is already occupied by an incompatible record: ${candidateId}`);
        }
        const updated = await dependencies.setExecutionExperimentCandidate(id, candidateId, scope);
        return { experiment: updated, candidateRunSpec: recovered };
      }
      const candidate = applyExecutionExperimentDiff(source, experiment.configDiff);
      const selectedAt = new Date();
      const created = await dependencies.createRunSpec({
        id: candidateId,
        sessionId: `${experiment.source.sessionId}:experiment:${id}`,
        tenantId: experiment.tenantId,
        projectId: experiment.projectId,
        userId: context.userId,
        requestId: context.requestId,
        traceId: context.traceId,
        prompt: source.prompt,
        systemPrompt: source.systemPrompt,
        provider: candidate.provider,
        model: candidate.model,
        modelSettings: candidate.modelSettings,
        workspaceRoot: candidate.workspaceRoot,
        toolMode: 'read-only',
        allowedTools: candidate.allowedTools,
        toolRetry: candidate.toolRetry,
        maxLoops: candidate.maxLoops,
        timeoutMs: candidate.timeoutMs,
        mcpServers: candidate.mcpServers,
        runContract: {
          ...source.runContract,
          mode: 'audit',
          executionMode: 'standard',
          toolMode: 'read-only',
          phase: 'planning',
          previousPhase: 'created',
          phaseChangedAt: selectedAt.toISOString(),
          planParentRunSpecId: source.id,
          executionKernel: createK4ExecutionKernelSelection({
            experimentId: id,
            disposition: candidatePolicy.disposition,
            actor: context.userId,
            now: selectedAt,
          }),
        },
      });
      const updated = await dependencies.setExecutionExperimentCandidate(id, candidateId, scope);
      return { experiment: updated, candidateRunSpec: created };
    } catch (err) {
      return reply.status(422).send({ error: err instanceof Error ? err.message : String(err) });
    }
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

  app.post('/execution-experiments/:id/authorize-canary', async (req, reply) => {
    if (!(await dependencies.requireOperator(req, reply))) return;
    const id = (req.params as { id: string }).id;
    const context = getRequestContext(req);
    const scope = { tenantId: context.tenantId, projectId: context.projectId };
    const experiment = await dependencies.loadExecutionExperiment(id, scope);
    if (!experiment) return reply.status(404).send({ error: 'Execution experiment not found' });
    if (experiment.status !== 'approved') return reply.status(409).send({ error: `canary authorization requires approved experiment (status=${experiment.status})` });
    if (!experiment.candidateRunSpecId) return reply.status(409).send({ error: 'candidate run spec must be selected before canary authorization' });
    const body = asRecord(req.body);
    if (body.confirmCandidateRunSpecId !== experiment.candidateRunSpecId) {
      return reply.status(422).send({ error: 'confirmCandidateRunSpecId must exactly match the candidate run spec' });
    }
    const candidate = await dependencies.loadRunSpec(experiment.candidateRunSpecId);
    if (!candidate || !matchesExperimentScope(candidate, experiment)) return reply.status(422).send({ error: 'candidate run spec not found in experiment scope' });
    if (candidate.runContract?.phase !== 'plan_approved') return reply.status(409).send({ error: 'candidate plan must be approved before canary authorization' });
    try {
      const executionKernel = await dependencies.authorizeRunSpecKernelCanary({
        runSpecId: candidate.id,
        experimentId: id,
        actor: context.userId,
      });
      return { experiment, candidateRunSpecId: candidate.id, executionKernel };
    } catch (err) {
      return reply.status(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/execution-experiments/:id/rollback', async (req, reply) => {
    if (!(await dependencies.requireOperator(req, reply))) return;
    const id = (req.params as { id: string }).id;
    const context = getRequestContext(req);
    const scope = { tenantId: context.tenantId, projectId: context.projectId };
    const experiment = await dependencies.loadExecutionExperiment(id, scope);
    if (!experiment) return reply.status(404).send({ error: 'Execution experiment not found' });
    if (!experiment.candidateRunSpecId) return reply.status(409).send({ error: 'candidate run spec must be selected before rollback' });
    const reason = normalizeOptionalString(asRecord(req.body).reason);
    try {
      const executionKernel = await dependencies.rollbackRunSpecExecutionKernel({
        runSpecId: experiment.candidateRunSpecId,
        experimentId: id,
        actor: context.userId,
        reason,
      });
      return { experiment, candidateRunSpecId: experiment.candidateRunSpecId, executionKernel };
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
      const k4Candidate = readK4KernelCandidate(experiment.configDiff);
      const source = await dependencies.loadRunSpec(experiment.source.runSpecId);
      if (!source || !matchesExperimentScope(source, experiment)) {
        return reply.status(422).send({ error: 'source run spec not found in experiment scope' });
      }
      if (!source.runContract?.plan?.length) return reply.status(422).send({ error: 'source run spec has no persisted plan; AP2 blocks execution' });
      const config = getConfig();
      const candidateId = experiment.candidateRunSpecId ?? `run-${id}-candidate`;
      if (!experiment.candidateRunSpecId) {
        if (k4Candidate) throw new Error('K4 candidate run spec must be selected before execution');
        const candidate = applyExecutionExperimentDiff(source, experiment.configDiff);
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
        if (k4Candidate) {
          if (current.runContract.executionKernel?.disposition !== 'planning') {
            throw new Error('inspection candidate plan must be approved before execution');
          }
        } else {
        await dependencies.approveRunSpecPhase(candidateId, {
          actor: context.userId,
          reason: `execution experiment ${id} approved candidate`,
        });
        current = await dependencies.loadRunSpec(candidateId);
        if (!current || !matchesExperimentScope(current, experiment)) {
          throw new Error('candidate run spec disappeared from experiment scope after approval');
        }
        }
      }
      if (current.runContract?.phase !== 'plan_approved' && current.runContract?.executionKernel?.disposition !== 'planning') {
        throw new Error(`candidate run spec must be plan_approved before execution (phase=${current.runContract?.phase ?? 'missing'})`);
      }
      if (k4Candidate) {
        const policyError = validateK4ExecutionKernelSelection(current.runContract?.executionKernel, {
          runContractMode: current.runContract?.mode,
          toolMode: current.toolMode,
          executorEnabled: false,
          requireCanaryAuthorization: true,
        });
        if (policyError) throw new Error(policyError);
      }
      if (current.runContract?.executionKernel?.disposition !== 'planning') {
        await dependencies.transitionExecutionState({ entityType: 'run_spec', entityId: candidateId, to: 'running', sessionId: current.sessionId, reason: 'execution_experiment_started' });
      }
      await dependencies.transitionExecutionExperiment(id, 'running', 'execution_experiment_started', scope);
      const result = await dependencies.runScheduledAgentTask({
        prompt: current.prompt, sessionId: current.sessionId, runSpecId: current.id, provider: current.provider,
        model: current.model, systemPrompt: current.systemPrompt, workspaceRoot: current.workspaceRoot,
        toolMode: current.toolMode as 'all' | 'project-write' | 'read-only', allowedTools: current.allowedTools,
        maxLoops: current.maxLoops, timeoutMs: current.timeoutMs, toolRetry: current.toolRetry,
        mcpServers: current.mcpServers, traceId: current.traceId, requestId: current.requestId,
        tenantId: current.tenantId, projectId: current.projectId, userId: current.userId,
        executionKernelKind: current.runContract?.executionKernel?.selected.kind,
        runContract: current.runContract,
        sandboxMode: k4Candidate ? 'readonly' : undefined,
        executor: k4Candidate
          ? { enabled: false }
          : { enabled: config.executor.enabled, nodeUrls: config.executor.meshNodes, agentKey: config.executor.agentKey, nodeId: config.executor.nodeId },
        onTaskEvent: () => undefined,
      });
      if (k4Candidate?.disposition === 'planning') {
        const final = await dependencies.transitionExecutionExperiment(id, 'blocked', 'candidate_plan_awaiting_approval', scope);
        return { experiment: final, candidateRunSpecId: candidateId, result };
      }
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
