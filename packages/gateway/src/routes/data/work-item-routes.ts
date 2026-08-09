import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  createQuickWorkItem,
  createWorkItem,
  createWorkItemRevision,
  getWorkItemVerificationCoverage,
  isWorkItemReviewError,
  linkWorkItemRun,
  listInboxEntries,
  listWorkItemProjections,
  loadWorkItemProjection,
  reviewWorkItemResult,
  type WorkItemMode,
} from '@los/agent/work-items';
import { ensureRunSpecStore, createRunSpec } from '@los/agent/run-specs';
import type { TodoPriority, TodoStatus } from '@los/agent/todos';

import { runIdempotentJson } from '../../idempotency.js';
import { getRequestContext, requireOperator } from '../../request-context.js';
import { dispatchPersistedRunSpec } from '../../run-resume-dispatch.js';
import { updateBoundTodoFromRun } from '../../chat-session-helpers.js';

export type WorkItemRouteDependencies = {
  createQuickWorkItem: typeof createQuickWorkItem;
  createWorkItem: typeof createWorkItem;
  createWorkItemRevision: typeof createWorkItemRevision;
  getWorkItemVerificationCoverage: typeof getWorkItemVerificationCoverage;
  isWorkItemReviewError: typeof isWorkItemReviewError;
  listInboxEntries: typeof listInboxEntries;
  listWorkItemProjections: typeof listWorkItemProjections;
  loadWorkItemProjection: typeof loadWorkItemProjection;
  reviewWorkItemResult: typeof reviewWorkItemResult;
  ensureRunSpecStore: typeof ensureRunSpecStore;
  createRunSpec: typeof createRunSpec;
  linkWorkItemRun: typeof linkWorkItemRun;
  updateBoundTodoFromRun: typeof updateBoundTodoFromRun;
  dispatchPersistedRunSpec: typeof dispatchPersistedRunSpec;
};

const defaultDependencies: WorkItemRouteDependencies = {
  createQuickWorkItem,
  createWorkItem,
  createWorkItemRevision,
  getWorkItemVerificationCoverage,
  isWorkItemReviewError,
  listInboxEntries,
  listWorkItemProjections,
  loadWorkItemProjection,
  reviewWorkItemResult,
  ensureRunSpecStore,
  createRunSpec,
  linkWorkItemRun,
  updateBoundTodoFromRun,
  dispatchPersistedRunSpec,
};

export function registerWorkItemRoutes(
  app: FastifyInstance,
  deps: WorkItemRouteDependencies = defaultDependencies,
): void {
  app.get('/inbox', async (req) => {
    const query = req.query as { projectId?: string; limit?: string };
    const context = getRequestContext(req);
    const entries = await deps.listInboxEntries({
      tenantId: context.tenantId,
      projectId: normalizeOptionalString(query.projectId) ?? context.projectId,
      limit: normalizePositiveInteger(query.limit),
    });
    return { count: entries.length, results: entries };
  });

  app.get('/work-items', async (req) => {
    const query = req.query as {
      projectId?: string;
      status?: string;
      limit?: string;
      excludeTerminal?: string | boolean;
    };
    const context = getRequestContext(req);
    const status = normalizeTodoStatus(query.status);
    // Specific status wins; excludeTerminal only applies to unscoped lists.
    const excludeTerminal = status ? undefined : normalizeBoolean(query.excludeTerminal);
    const results = await deps.listWorkItemProjections({
      tenantId: context.tenantId,
      projectId: normalizeOptionalString(query.projectId) ?? context.projectId,
      status,
      excludeTerminal,
      limit: normalizePositiveInteger(query.limit),
    });
    return { count: results.length, results };
  });

  app.get('/work-items/verification-coverage', async (req) => {
    const query = req.query as { projectId?: string; mode?: string };
    const context = getRequestContext(req);
    return await deps.getWorkItemVerificationCoverage({
      tenantId: context.tenantId,
      projectId: normalizeOptionalString(query.projectId) ?? context.projectId,
      mode: normalizeMode(query.mode),
    });
  });

  app.get('/work-items/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await deps.loadWorkItemProjection(id);
    if (!result) return reply.status(404).send({ error: 'work item not found' });
    return result;
  });

  app.post('/work-items', async (req, reply) => {
    const body = asObject(req.body);
    const context = getRequestContext(req);
    const validation = validateCreateBody(body);
    if ('error' in validation) return reply.status(400).send(validation);
    reply.status(201);
    return await runIdempotentJson(
      req,
      reply,
      { route: '/work-items', method: 'POST', body, context },
      async () => await deps.createWorkItem({
        tenantId: context.tenantId,
        projectId: validation.projectId,
        userId: context.userId,
        title: normalizeOptionalString(body.title),
        goal: validation.goal,
        description: normalizeOptionalString(body.description),
        mode: validation.mode,
        editableSurfaces: validation.editableSurfaces,
        nonGoals: normalizeStringArray(body.nonGoals),
        requiredChecks: validation.requiredChecks,
        stopConditions: validation.stopConditions,
        evidenceRequired: normalizeStringArray(body.evidenceRequired),
        toolMode: normalizeToolMode(body.toolMode),
        priority: normalizePriority(body.priority),
      }),
    );
  });

  app.post('/work-items/quick', async (req, reply) => {
    const body = asObject(req.body);
    const context = getRequestContext(req);
    const goal = normalizeOptionalString(body.goal);
    const projectId = normalizeOptionalString(body.projectId) ?? context.projectId;
    if (!projectId) return reply.status(400).send({ error: 'invalid_request', message: 'projectId is required' });
    if (!goal) return reply.status(400).send({ error: 'invalid_request', message: 'goal is required' });
    const mode = normalizeMode(body.mode) ?? 'execution';
    reply.status(201);
    return await runIdempotentJson(
      req,
      reply,
      { route: '/work-items/quick', method: 'POST', body, context },
      async () => await deps.createQuickWorkItem({
        tenantId: context.tenantId,
        projectId,
        userId: context.userId,
        goal,
        mode,
      }),
    );
  });

  app.post('/work-items/:id/start', (req, reply) => handleStartWorkItem(req, reply, deps));
  app.post('/work-items/:id/result-decision', async (req, reply) => {    if (!(await requireOperator(req, reply))) return;
    const { id } = req.params as { id: string };
    const body = asObject(req.body);
    const decision = normalizeResultDecision(body.decision);
    const reason = normalizeOptionalString(body.reason);
    if (!decision || !reason) {
      return reply.status(400).send({ error: 'invalid_request', message: 'decision and reason are required' });
    }
    const context = getRequestContext(req);
    try {
      return await runIdempotentJson(
        req,
        reply,
        { route: `/work-items/${id}/result-decision`, method: 'POST', body, context },
        async () => {
          const updated = await deps.reviewWorkItemResult({
            workItemId: id,
            decision,
            actor: context.userId,
            reason,
            closeoutReport: normalizeCloseoutReport(body.closeoutReport),
          });
          if (decision !== 'revision_requested' || !updated.evidence.latestRunSpecId) return updated;
          const recovery = await deps.createWorkItemRevision({
            runSpecId: updated.evidence.latestRunSpecId,
            actor: context.userId,
            reason,
            trigger: 'revision_requested',
          });
          if (!recovery.exhausted) {
            void dispatchPersistedRunSpec(recovery.runSpecId, 'planning').catch(() => undefined);
          }
          return { ...updated, recovery };
        },
      );
    } catch (error) {
      if (!deps.isWorkItemReviewError(error)) throw error;
      const status = error.code === 'not_found' ? 404 : 409;
      return reply.status(status).send({ error: error.code, message: error.message });
    }
  });
}

function validateCreateBody(body: Record<string, unknown>):
  | {
      projectId: string;
      goal: string;
      mode: WorkItemMode;
      editableSurfaces: string[];
      requiredChecks: string[];
      stopConditions: string[];
    }
  | { error: string; message: string } {
  const projectId = normalizeOptionalString(body.projectId);
  const goal = normalizeOptionalString(body.goal);
  const mode = normalizeMode(body.mode);
  if (!projectId) return { error: 'invalid_request', message: 'projectId is required' };
  if (!goal) return { error: 'invalid_request', message: 'goal is required' };
  if (!mode) return { error: 'invalid_request', message: 'mode is invalid' };
  for (const field of ['editableSurfaces', 'requiredChecks', 'stopConditions'] as const) {
    if (!Array.isArray(body[field])) {
      return { error: 'invalid_request', message: `${field} must be an array` };
    }
  }
  return {
    projectId,
    goal,
    mode,
    editableSurfaces: normalizeStringArray(body.editableSurfaces),
    requiredChecks: normalizeStringArray(body.requiredChecks),
    stopConditions: normalizeStringArray(body.stopConditions),
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeOptionalString).filter((item): item is string => Boolean(item)))];
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) return undefined;
  const normalized = Math.floor(number);
  return normalized > 0 ? normalized : undefined;
}

function normalizeMode(value: unknown): WorkItemMode | undefined {
  if (
    value === 'audit'
    || value === 'execution'
    || value === 'closeout'
    || value === 'governance'
    || value === 'feed-analysis-ingress'
  ) return value;
  return undefined;
}

function normalizeToolMode(value: unknown): 'read-only' | 'project-write' | undefined {
  if (value === 'read-only' || value === 'project-write') return value;
  return undefined;
}

function normalizePriority(value: unknown): TodoPriority | undefined {
  if (value === 'P0' || value === 'P1' || value === 'P2' || value === 'P3') return value;
  return undefined;
}

function normalizeTodoStatus(value: unknown): TodoStatus | undefined {
  if (
    value === 'backlog'
    || value === 'ready'
    || value === 'in_progress'
    || value === 'blocked'
    || value === 'done'
    || value === 'cancelled'
  ) return value;
  return undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return undefined;
}

function normalizeResultDecision(value: unknown): 'accepted' | 'revision_requested' | undefined {
  return value === 'accepted' || value === 'revision_requested' ? value : undefined;
}

/**
 * POST /work-items/:id/start — begin the planning phase server-side.
 *
 * Closes the "created → planning" gap: the work item's goal becomes a run
 * spec with a planning disposition, linked to the work item, dispatched
 * through the ordinary persisted-run path, and the todo moves to
 * in_progress. The UI Start button calls this instead of falling back to a
 * manual chat round-trip.
 */
async function handleStartWorkItem(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: WorkItemRouteDependencies,
) {
  const { id } = req.params as { id: string };
  const context = getRequestContext(req);
  const projection = await deps.loadWorkItemProjection(id);
  if (!projection) return reply.status(404).send({ error: 'work item not found' });
  if (projection.status !== 'backlog' && projection.status !== 'ready') {
    return reply.status(409).send({
      error: `work item must be backlog/ready to start planning (status=${projection.status})`,
    });
  }
  if ((projection.links ?? []).some(link => link.relationKind === 'planning')) {
    return reply.status(409).send({ error: 'planning run already started for this work item' });
  }
  try {
    await deps.ensureRunSpecStore();
    const runSpecId = `run-${id}-plan-${Date.now()}`;
    const sessionId = `wi:${id}`;
    const now = new Date().toISOString();
    const draft = projection.runContractDraft ?? {};
    await deps.createRunSpec({
      id: runSpecId,
      sessionId,
      tenantId: context.tenantId,
      projectId: context.projectId,
      userId: context.userId,
      requestId: context.requestId,
      traceId: context.traceId,
      prompt: projection.goal || projection.title,
      modelSettings: {},
      workspaceRoot: process.cwd(),
      toolMode: 'read-only',
      allowedTools: [],
      toolRetry: {},
      // Planning needs enough rounds for read-only investigation plus the
      // submit_run_contract submission (default 20 rounds got exhausted by
      // investigation alone in dogfood runs).
      maxLoops: 60,
      timeoutMs: undefined,
      mcpServers: [],
      runContract: {
        ...draft,
        mode: 'execution',
        phase: 'planning',
        previousPhase: 'created',
        phaseChangedAt: now,
      },
    });
    await deps.linkWorkItemRun({
      workItemId: id,
      runSpecId,
      sessionId,
      relationKind: 'planning',
    });
    await deps.updateBoundTodoFromRun(id, {
      status: 'in_progress',
      sessionId,
      traceId: context.traceId,
      requestId: context.requestId,
      runSpecId,
      event: 'planning_started',
    });
    const dispatch = await deps.dispatchPersistedRunSpec(runSpecId, 'planning');
    return { workItemId: id, runSpecId, planning: dispatch };
  } catch (err) {
    return reply.status(422).send({ error: err instanceof Error ? err.message : String(err) });
  }
}

function normalizeCloseoutReport(value: unknown) {
  const report = asObject(value);
  return {
    dirtyPaths: normalizeStringArray(report.dirtyPaths),
    changeId: normalizeOptionalString(report.changeId),
    bookmark: normalizeOptionalString(report.bookmark),
    checks: normalizeStringArray(report.checks),
    residualRisk: normalizeOptionalString(report.residualRisk),
  };
}
