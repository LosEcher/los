import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  approveExecutionExperiment, createExecutionExperiment, loadExecutionExperiment,
  setExecutionExperimentCandidate, transitionExecutionExperiment,
  runScheduledAgentTask, loadRunSpec, createRunSpec,
  type ExecutionExperimentConfigDiff,
} from '@los/agent';
import { transitionExecutionState } from '@los/agent/execution-store';
import { getConfig } from '@los/infra/config';
import { asRecord, normalizeOptionalString, normalizeBoundedInteger } from '../server-helpers.js';
import { getRequestContext, requireOperator } from '../../request-context.js';
import { applyDirectRunCompletionStatus } from '../../chat-run-completion.js';

const ALLOWED_DIFF_PATHS = new Set(['provider', 'model', 'toolMode', 'allowedTools', 'maxLoops', 'timeoutMs', 'modelSettings']);

export function registerExecutionExperimentRoutes(app: FastifyInstance): void {
  app.post('/execution-experiments', async (req, reply) => {
    const body = asRecord(req.body);
    const source = asRecord(body.source);
    const configDiff = parseConfigDiff(body.configDiff);
    if (!source.sessionId || !source.runSpecId || source.eventCursor === undefined || !source.evidenceHash) {
      return reply.status(422).send({ error: 'source.sessionId, source.runSpecId, source.eventCursor, and source.evidenceHash are required' });
    }
    try {
      const record = await createExecutionExperiment({
        id: normalizeOptionalString(body.id) ?? `experiment-${randomUUID()}`,
        tenantId: getRequestContext(req).tenantId,
        projectId: getRequestContext(req).projectId,
        source: {
          sessionId: String(source.sessionId), runSpecId: String(source.runSpecId),
          eventCursor: normalizeBoundedInteger(source.eventCursor, 0, 0, Number.MAX_SAFE_INTEGER),
          evidenceHash: String(source.evidenceHash),
          fingerprint: asRecord(source.fingerprint) as any,
        },
        configDiff,
        createdBy: getRequestContext(req).userId,
      });
      return reply.status(201).send({ experiment: record });
    } catch (err) {
      return reply.status(422).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/execution-experiments/:id', async (req, reply) => {
    const record = await loadExecutionExperiment((req.params as { id: string }).id);
    return record ? { experiment: record } : reply.status(404).send({ error: 'Execution experiment not found' });
  });

  app.post('/execution-experiments/:id/approve', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    try {
      const record = await approveExecutionExperiment((req.params as { id: string }).id, getRequestContext(req).userId);
      return { experiment: record };
    } catch (err) {
      return reply.status(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/execution-experiments/:id/execute', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const id = (req.params as { id: string }).id;
    const experiment = await loadExecutionExperiment(id);
    if (!experiment) return reply.status(404).send({ error: 'Execution experiment not found' });
    if (experiment.status !== 'approved') return reply.status(409).send({ error: `experiment must be approved before execution (status=${experiment.status})` });
    try {
      const source = await loadRunSpec(experiment.source.runSpecId);
      if (!source) return reply.status(422).send({ error: 'source run spec not found' });
      if (!source.runContract?.plan?.length) return reply.status(422).send({ error: 'source run spec has no persisted plan; AP2 blocks execution' });
      const config = getConfig();
      const candidateId = experiment.candidateRunSpecId ?? `run-${id}-candidate`;
      if (!experiment.candidateRunSpecId) {
        const candidate = applyDiffToRunSpec(source, experiment.configDiff);
        await createRunSpec({
          id: candidateId,
          sessionId: `${experiment.source.sessionId}:experiment:${id}`,
          tenantId: experiment.tenantId, projectId: experiment.projectId,
          userId: getRequestContext(req).userId, requestId: getRequestContext(req).requestId,
          traceId: getRequestContext(req).traceId, prompt: source.prompt,
          systemPrompt: source.systemPrompt, provider: candidate.provider, model: candidate.model,
          modelSettings: candidate.modelSettings, workspaceRoot: candidate.workspaceRoot,
          toolMode: candidate.toolMode, allowedTools: candidate.allowedTools, toolRetry: candidate.toolRetry,
          maxLoops: candidate.maxLoops, timeoutMs: candidate.timeoutMs, mcpServers: candidate.mcpServers,
          runContract: { ...source.runContract, phase: 'plan_approved', previousPhase: 'planning' },
        });
        await setExecutionExperimentCandidate(id, candidateId);
      }
      const current = await loadRunSpec(candidateId);
      if (!current) throw new Error('candidate run spec was not created');
      await transitionExecutionState({ entityType: 'run_spec', entityId: candidateId, to: 'running', sessionId: current.sessionId, reason: 'execution_experiment_started' });
      await transitionExecutionExperiment(id, 'running', 'execution_experiment_started');
      const result = await runScheduledAgentTask({
        prompt: current.prompt, sessionId: current.sessionId, runSpecId: current.id, provider: current.provider,
        model: current.model, systemPrompt: current.systemPrompt, workspaceRoot: current.workspaceRoot,
        toolMode: current.toolMode as 'all' | 'project-write' | 'read-only', allowedTools: current.allowedTools,
        maxLoops: current.maxLoops, timeoutMs: current.timeoutMs, toolRetry: current.toolRetry,
        mcpServers: current.mcpServers, traceId: current.traceId, requestId: current.requestId,
        tenantId: current.tenantId, projectId: current.projectId, userId: current.userId,
        runContract: current.runContract, executor: { enabled: config.executor.enabled, nodeUrls: config.executor.meshNodes, agentKey: config.executor.agentKey, nodeId: config.executor.nodeId },
        onTaskEvent: () => undefined,
      });
      const completion = await applyDirectRunCompletionStatus({ runSpecId: candidateId, sessionId: current.sessionId, tenantId: current.tenantId, projectId: current.projectId, userId: current.userId, requestId: current.requestId, traceId: current.traceId, taskRunId: result.taskRun.id });
      const final = completion.status === 'succeeded'
        ? await transitionExecutionExperiment(id, 'succeeded', 'candidate_run_completed')
        : await transitionExecutionExperiment(id, 'blocked', 'candidate_verification_blocked');
      return { experiment: final, candidateRunSpecId: candidateId, completion };
    } catch (err) {
      await transitionExecutionExperiment(id, 'failed', 'candidate_execution_failed').catch(() => undefined);
      return reply.status(422).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

function parseConfigDiff(value: unknown): ExecutionExperimentConfigDiff[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = asRecord(item);
    const path = normalizeOptionalString(row.path);
    if (!path || !ALLOWED_DIFF_PATHS.has(path)) throw new Error(`configDiff path is not allowed: ${String(row.path)}`);
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
