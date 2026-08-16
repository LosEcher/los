import type { FastifyInstance } from 'fastify';
import type { ExecutorCapabilityRequirement } from '@los/agent/scheduler';
import {
  createScheduledWorkItem,
  executeScheduledWorkRun,
  approveScheduledWorkRun,
  denyScheduledWorkRun,
  listScheduledWorkItemRuns,
  listScheduledWorkItems,
  loadScheduledWorkItem,
  previewScheduledOccurrences,
  retryScheduledWorkRun,
  triggerScheduledWorkItem,
  updateScheduledWorkItem,
  type CreateScheduledWorkItemInput,
  type ScheduledWorkTrigger,
  type ScheduledWorkRunTemplate,
  type UpdateScheduledWorkItemInput,
} from '@los/agent/scheduled-work';

import { runIdempotentJson } from '../../idempotency.js';
import { getRequestContext, requireOperator } from '../../request-context.js';

export type ScheduledWorkRouteDeps = {
  create: typeof createScheduledWorkItem;
  list: typeof listScheduledWorkItems;
  load: typeof loadScheduledWorkItem;
  update: typeof updateScheduledWorkItem;
  listRuns: typeof listScheduledWorkItemRuns;
  preview: typeof previewScheduledOccurrences;
  trigger: typeof triggerScheduledWorkItem;
  retry: typeof retryScheduledWorkRun;
  approve: typeof approveScheduledWorkRun;
  deny: typeof denyScheduledWorkRun;
  execute: typeof executeScheduledWorkRun;
};

const defaultDeps: ScheduledWorkRouteDeps = {
  create: createScheduledWorkItem, list: listScheduledWorkItems, load: loadScheduledWorkItem,
  update: updateScheduledWorkItem, listRuns: listScheduledWorkItemRuns,
  preview: previewScheduledOccurrences, trigger: triggerScheduledWorkItem,
  retry: retryScheduledWorkRun, approve: approveScheduledWorkRun, deny: denyScheduledWorkRun, execute: executeScheduledWorkRun,
};

export function registerScheduledWorkRoutes(
  app: FastifyInstance,
  deps: ScheduledWorkRouteDeps = defaultDeps,
): void {
  app.get('/scheduled-work-items/preview', async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    try {
      const trigger = normalizeTrigger({ kind: query.kind, expression: query.expression, timezone: query.timezone });
      return { trigger, occurrences: deps.preview(trigger, new Date(), 3) };
    } catch (error) {
      return reply.status(400).send({ error: errorMessage(error) });
    }
  });

  app.get('/scheduled-work-items', async req => {
    const query = req.query as {
      projectId?: string;
      status?: string;
      limit?: string;
      excludeRetired?: string | boolean;
    };
    const context = getRequestContext(req);
    const status = normalizeStatus(query.status);
    const results = await deps.list({
      projectId: normalizeString(query.projectId) ?? context.projectId,
      status,
      // Concrete status wins; excludeRetired only for unscoped lists.
      excludeRetired: status ? undefined : normalizeBoolean(query.excludeRetired),
      limit: normalizeLimit(query.limit),
    });
    return { count: results.length, results };
  });

  app.post('/scheduled-work-items', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const context = getRequestContext(req);
    return runIdempotentJson(req, reply, {
      route: '/scheduled-work-items', method: 'POST', body, context,
    }, async () => {
      try {
        const input = normalizeCreateInput(body, context);
        const schedule = await deps.create(input);
        return reply.status(201).send({ schedule, occurrences: deps.preview(schedule.trigger, new Date(), 3) });
      } catch (error) {
        return reply.status(400).send({ error: errorMessage(error) });
      }
    });
  });

  app.get('/scheduled-work-items/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const schedule = await deps.load(id);
    if (!schedule) return reply.status(404).send({ error: 'schedule not found' });
    return { schedule, runs: await deps.listRuns(id, 100) };
  });

  app.patch('/scheduled-work-items/:id', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const context = getRequestContext(req);
    return runIdempotentJson(req, reply, {
      route: `/scheduled-work-items/${id}`, method: 'PATCH', body, context,
    }, async () => {
      try {
        const schedule = await deps.update(id, normalizeUpdateInput(body));
        if (!schedule) return reply.status(404).send({ error: 'schedule not found' });
        return schedule;
      } catch (error) {
        return reply.status(400).send({ error: errorMessage(error) });
      }
    });
  });

  app.post('/scheduled-work-items/:id/trigger', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const context = getRequestContext(req);
    return runIdempotentJson(req, reply, {
      route: `/scheduled-work-items/${id}/trigger`, method: 'POST', body, context,
    }, async () => {
      try {
        return await deps.trigger({
          scheduleId: id,
          ownerId: `manual:${context.userId ?? 'operator'}`,
          scheduledFor: normalizeDate(body.scheduledFor),
        });
      } catch (error) {
        return reply.status(errorMessage(error).includes('not found') ? 404 : 409).send({ error: errorMessage(error) });
      }
    });
  });

  app.post('/scheduled-work-item-runs/:id/retry', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const { id } = req.params as { id: string };
    const context = getRequestContext(req);
    try {
      const run = await deps.retry({ runId: id, ownerId: `manual:${context.userId ?? 'operator'}` });
      await deps.execute(run);
      return { runId: run.id, accepted: true };
    } catch (error) {
      return reply.status(409).send({ error: errorMessage(error) });
    }
  });

  app.post('/scheduled-work-item-runs/:id/approve', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const { id } = req.params as { id: string };
    const context = getRequestContext(req);
    try {
      const run = await deps.approve(id, { ownerId: `manual:${context.userId ?? 'operator'}` });
      return { runId: run.id, status: run.status };
    } catch (error) {
      return reply.status(409).send({ error: errorMessage(error) });
    }
  });

  app.post('/scheduled-work-item-runs/:id/deny', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const { id } = req.params as { id: string };
    const context = getRequestContext(req);
    try {
      const run = await deps.deny(id, { ownerId: `manual:${context.userId ?? 'operator'}` });
      return { runId: run.id, status: run.status };
    } catch (error) {
      return reply.status(409).send({ error: errorMessage(error) });
    }
  });
}

function normalizeCreateInput(
  body: Record<string, unknown>,
  context: ReturnType<typeof getRequestContext>,
): CreateScheduledWorkItemInput {
  // Fail fast instead of silently falling back to a default template: a wrong
  // templateId or a nested `runTemplate` object (the API only accepts flat
  // fields) otherwise creates a schedule that runs the wrong template with no
  // error surfaced. D3.
  const TEMPLATE_IDS = [
    'morning_inbox_digest',
    'runtime_readiness',
    'scheduled_feed_analysis',
    'scheduled_execution',
    'daily_execution_digest',
    'fleet_host_check',
  ] as const;
  if (body.templateId !== undefined
    && !(TEMPLATE_IDS as readonly string[]).includes(String(body.templateId))) {
    throw new Error(`invalid templateId: ${String(body.templateId)}`);
  }
  if (body.runTemplate !== undefined) {
    throw new Error('nested runTemplate is not accepted; use flat fields: templateId, goalTemplate, editableSurfaces, requiredChecks');
  }
  const templateId = normalizeEnum(
    body.templateId,
    TEMPLATE_IDS,
    'morning_inbox_digest',
  );
  const title = normalizeString(body.title);
  if (!title) throw new Error('title is required');
  const isExecution = templateId === 'scheduled_execution';
  const isGovernance =
    templateId === 'runtime_readiness'
    || templateId === 'daily_execution_digest'
    || templateId === 'fleet_host_check';
  return {
    tenantId: context.tenantId, projectId: normalizeString(body.projectId) ?? context.projectId,
    userId: context.userId, title, trigger: normalizeTrigger(body.trigger),
    runTemplate: {
      templateId,
      mode: isExecution ? 'execution' : (isGovernance ? 'governance' : 'audit'),
      goalTemplate: normalizeString(body.goalTemplate) ?? defaultGoal(templateId),
      editableSurfaces: isExecution ? normalizeStringArray(body.editableSurfaces) : [],
      requiredChecks: isExecution ? normalizeStringArray(body.requiredChecks) : [],
      toolMode: isExecution ? normalizeToolMode(body.toolMode) : 'read-only',
      sandboxMode: isExecution ? normalizeSandboxMode(body.sandboxMode) : undefined,
      executor: isExecution ? normalizeExecutorConfig(body.executor) : undefined,
      maxLoops: isExecution ? normalizeMaxLoops(body.maxLoops) : undefined,
      workspaceRoot: isExecution ? normalizeWorkspaceRoot(body.workspaceRoot) : undefined,
      feedAnalysisRequest: templateId === 'scheduled_feed_analysis'
        ? normalizeFeedAnalysisRequest(body.feedAnalysisRequest)
        : undefined,
    },
    approvalPolicy: normalizeEnum(body.approvalPolicy, ['read_only_auto', 'preapproved_scope', 'each_run'] as const, isExecution ? 'preapproved_scope' : 'read_only_auto'),
    approvalTimeoutMs: normalizeNumber(body.approvalTimeoutMs),
    approvalTimeoutAction: optionalEnum(body.approvalTimeoutAction, ['deny', 'approve'] as const),
    concurrencyPolicy: normalizeEnum(body.concurrencyPolicy, ['skip', 'queue_one', 'parallel'] as const, 'skip'),
    catchUpPolicy: normalizeEnum(body.catchUpPolicy, ['skip', 'run_once'] as const, 'skip'),
    maxConcurrentRuns: normalizeNumber(body.maxConcurrentRuns), maxLatenessMs: normalizeNumber(body.maxLatenessMs),
    failureThreshold: normalizeNumber(body.failureThreshold),
  };
}

function normalizeUpdateInput(body: Record<string, unknown>): UpdateScheduledWorkItemInput {
  if (body.runTemplate !== undefined) {
    throw new Error('nested runTemplate is not accepted on PATCH; use flat fields: goalTemplate, toolMode, sandboxMode, workspaceRoot, executor, maxLoops, editableSurfaces, requiredChecks');
  }
  const runTemplatePatch = collectRunTemplatePatch(body);
  return {
    title: normalizeString(body.title), status: normalizeStatus(body.status),
    trigger: body.trigger === undefined ? undefined : normalizeTrigger(body.trigger),
    ...(runTemplatePatch ? { runTemplate: runTemplatePatch } : {}),
    approvalPolicy: optionalEnum(body.approvalPolicy, ['read_only_auto', 'preapproved_scope', 'each_run'] as const),
    approvalTimeoutMs: normalizeNumber(body.approvalTimeoutMs),
    approvalTimeoutAction: optionalEnum(body.approvalTimeoutAction, ['deny', 'approve'] as const),
    concurrencyPolicy: optionalEnum(body.concurrencyPolicy, ['skip', 'queue_one', 'parallel'] as const),
    catchUpPolicy: optionalEnum(body.catchUpPolicy, ['skip', 'run_once'] as const),
    maxConcurrentRuns: normalizeNumber(body.maxConcurrentRuns), maxLatenessMs: normalizeNumber(body.maxLatenessMs),
    failureThreshold: normalizeNumber(body.failureThreshold),
  };
}

/** Build a partial runTemplate from flat PATCH fields; undefined body fields
 *  are omitted so the merge in the store keeps the persisted values. */
function collectRunTemplatePatch(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const patch: Record<string, unknown> = {};
  if (body.goalTemplate !== undefined) patch.goalTemplate = normalizeString(body.goalTemplate);
  if (body.editableSurfaces !== undefined) patch.editableSurfaces = normalizeStringArray(body.editableSurfaces);
  if (body.requiredChecks !== undefined) patch.requiredChecks = normalizeStringArray(body.requiredChecks);
  if (body.toolMode !== undefined) patch.toolMode = normalizeToolMode(body.toolMode);
  if (body.sandboxMode !== undefined) patch.sandboxMode = normalizeSandboxMode(body.sandboxMode);
  if (body.workspaceRoot !== undefined) patch.workspaceRoot = normalizeWorkspaceRoot(body.workspaceRoot);
  if (body.executor !== undefined) patch.executor = normalizeExecutorConfig(body.executor);
  if (body.maxLoops !== undefined) patch.maxLoops = normalizeMaxLoops(body.maxLoops);
  return Object.keys(patch).length > 0 ? patch : undefined;
}

function normalizeTrigger(value: unknown): ScheduledWorkTrigger {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const kind = normalizeEnum(input.kind, ['cron', 'interval', 'once'], 'cron');  const expression = normalizeString(input.expression);
  const timezone = normalizeString(input.timezone);
  if (!expression || !timezone) throw new Error('trigger expression and timezone are required');
  return { kind, expression, timezone };
}

function normalizeStatus(value: unknown): 'enabled' | 'paused' | 'retired' | undefined {
  return optionalEnum(value, ['enabled', 'paused', 'retired']);
}
function normalizeBoolean(value: unknown): boolean | undefined {
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return undefined;
}
function normalizeString(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function normalizeNumber(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function normalizeLimit(value: unknown): number | undefined { const parsed = Number(value); return Number.isFinite(parsed) ? Math.floor(parsed) : undefined; }
function normalizeDate(value: unknown): Date | undefined { const parsed = typeof value === 'string' ? new Date(value) : undefined; return parsed && Number.isFinite(parsed.getTime()) ? parsed : undefined; }
function normalizeEnum<T extends string>(value: unknown, choices: readonly T[], fallback: T): T { return choices.includes(value as T) ? value as T : fallback; }
function optionalEnum<T extends string>(value: unknown, choices: readonly T[]): T | undefined { return choices.includes(value as T) ? value as T : undefined; }
function defaultGoal(templateId: ScheduledWorkRunTemplate['templateId']): string {
  if (templateId === 'morning_inbox_digest') return 'Summarize persisted Inbox attention without calling a provider.';
  if (templateId === 'runtime_readiness') return 'Inspect persisted LOS runtime readiness without calling a provider.';
  if (templateId === 'daily_execution_digest') {
    return 'Compose UTC-yesterday daily execution digest and notify operator channels via ops.daily_digest.';
  }
  if (templateId === 'fleet_host_check') {
    return 'Bounded SSH host checks for named fleet remotes (unit/health/listen); rate-limited, no provider.';
  }
  if (templateId === 'scheduled_execution') return 'Execute the scheduled task with full project-write access within the approved scope.';
  return 'Dispatch a preapproved feed-analysis request and track its result and callback evidence.';
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(v => typeof v === 'string' ? v.trim() : '').filter(Boolean))];
}

function normalizeMaxLoops(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 200) {
    throw new Error(`maxLoops must be an integer in [1,200], got: ${String(value)}`);
  }
  return Math.floor(parsed);
}

function normalizeToolMode(value: unknown): 'all' | 'project-write' {
  return value === 'all' ? 'all' : 'project-write';
}

function normalizeSandboxMode(value: unknown): 'readonly' | 'workspace-write' | 'sandbox' | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'readonly' || value === 'workspace-write' || value === 'sandbox') return value;
  throw new Error(`sandboxMode must be one of readonly, workspace-write, sandbox, got: ${String(value)}`);
}

function normalizeWorkspaceRoot(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('workspaceRoot must be an absolute path');
  }
  const trimmed = value.trim();
  const isWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(trimmed);
  if (!trimmed.startsWith('/') && !isWindowsAbsolute) {
    throw new Error('workspaceRoot must be an absolute path (POSIX / or Windows drive, e.g. C:\\los)');
  }
  return trimmed;
}

function normalizeExecutorConfig(value: unknown): ScheduledWorkRunTemplate['executor'] {
  if (value === undefined || value === null) return undefined;
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('executor must be an object');
  }
  const nodeUrls = normalizeStringArray(input.nodeUrls);
  const requiredCapabilities = normalizeStringArray(input.requiredCapabilities)
    .filter((c): c is ExecutorCapabilityRequirement => EXECUTOR_CAPABILITIES.includes(c as ExecutorCapabilityRequirement));
  const nodeId = normalizeString(input.nodeId);
  const agentKey = normalizeString(input.agentKey);
  return {
    ...(input.enabled === undefined ? {} : { enabled: Boolean(input.enabled) }),
    ...(nodeId ? { nodeId } : {}),
    ...(nodeUrls.length > 0 ? { nodeUrls } : {}),
    ...(agentKey ? { agentKey } : {}),
    ...(requiredCapabilities.length > 0 ? { requiredCapabilities } : {}),
    ...(input.requiresBuild === undefined ? {} : { requiresBuild: Boolean(input.requiresBuild) }),
    ...(input.requiresDeploy === undefined ? {} : { requiresDeploy: Boolean(input.requiresDeploy) }),
    ...(normalizeNumber(input.leaseMs) ? { leaseMs: normalizeNumber(input.leaseMs) } : {}),
    ...(normalizeNumber(input.heartbeatMs) ? { heartbeatMs: normalizeNumber(input.heartbeatMs) } : {}),
  };
}

const EXECUTOR_CAPABILITIES: readonly string[] = [
  'workspace_read', 'workspace_write', 'shell', 'sandbox', 'network_egress',
  'heavy_task_safe', 'deploy_safe',
];

function normalizeFeedAnalysisRequest(value: unknown): ScheduledWorkRunTemplate['feedAnalysisRequest'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('feedAnalysisRequest is required for scheduled_feed_analysis');
  }
  const request = value as Record<string, unknown>;
  if ('sourceJobId' in request) throw new Error('scheduled sourceJobId is derived by LOS');
  if (!normalizeString(request.sourceSystem) || !normalizeString(request.deliveryMode)) {
    throw new Error('feedAnalysisRequest requires sourceSystem and deliveryMode');
  }
  return request as ScheduledWorkRunTemplate['feedAnalysisRequest'];
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
