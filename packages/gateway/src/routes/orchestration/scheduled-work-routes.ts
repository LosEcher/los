import type { FastifyInstance } from 'fastify';
import {
  createScheduledWorkItem,
  executeScheduledWorkRun,
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
  execute: typeof executeScheduledWorkRun;
};

const defaultDeps: ScheduledWorkRouteDeps = {
  create: createScheduledWorkItem, list: listScheduledWorkItems, load: loadScheduledWorkItem,
  update: updateScheduledWorkItem, listRuns: listScheduledWorkItemRuns,
  preview: previewScheduledOccurrences, trigger: triggerScheduledWorkItem,
  retry: retryScheduledWorkRun, execute: executeScheduledWorkRun,
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
    const query = req.query as { projectId?: string; status?: string; limit?: string };
    const context = getRequestContext(req);
    const results = await deps.list({
      projectId: normalizeString(query.projectId) ?? context.projectId,
      status: normalizeStatus(query.status),
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
}

function normalizeCreateInput(
  body: Record<string, unknown>,
  context: ReturnType<typeof getRequestContext>,
): CreateScheduledWorkItemInput {
  const templateId = normalizeEnum(
    body.templateId,
    ['morning_inbox_digest', 'runtime_readiness', 'scheduled_feed_analysis'] as const,
    'morning_inbox_digest',
  );
  const title = normalizeString(body.title);
  if (!title) throw new Error('title is required');
  return {
    tenantId: context.tenantId, projectId: normalizeString(body.projectId) ?? context.projectId,
    userId: context.userId, title, trigger: normalizeTrigger(body.trigger),
    runTemplate: {
      templateId, mode: templateId === 'runtime_readiness' ? 'governance' : 'audit',
      goalTemplate: normalizeString(body.goalTemplate) ?? defaultGoal(templateId),
      editableSurfaces: [], requiredChecks: [], toolMode: 'read-only',
      feedAnalysisRequest: templateId === 'scheduled_feed_analysis'
        ? normalizeFeedAnalysisRequest(body.feedAnalysisRequest)
        : undefined,
    },
    approvalPolicy: normalizeEnum(body.approvalPolicy, ['read_only_auto', 'preapproved_scope', 'each_run'] as const, 'read_only_auto'),
    concurrencyPolicy: normalizeEnum(body.concurrencyPolicy, ['skip', 'queue_one', 'parallel'] as const, 'skip'),
    catchUpPolicy: normalizeEnum(body.catchUpPolicy, ['skip', 'run_once'] as const, 'skip'),
    maxConcurrentRuns: normalizeNumber(body.maxConcurrentRuns), maxLatenessMs: normalizeNumber(body.maxLatenessMs),
    failureThreshold: normalizeNumber(body.failureThreshold),
  };
}

function normalizeUpdateInput(body: Record<string, unknown>): UpdateScheduledWorkItemInput {
  return {
    title: normalizeString(body.title), status: normalizeStatus(body.status),
    trigger: body.trigger === undefined ? undefined : normalizeTrigger(body.trigger),
    approvalPolicy: optionalEnum(body.approvalPolicy, ['read_only_auto', 'preapproved_scope', 'each_run'] as const),
    concurrencyPolicy: optionalEnum(body.concurrencyPolicy, ['skip', 'queue_one', 'parallel'] as const),
    catchUpPolicy: optionalEnum(body.catchUpPolicy, ['skip', 'run_once'] as const),
    maxConcurrentRuns: normalizeNumber(body.maxConcurrentRuns), maxLatenessMs: normalizeNumber(body.maxLatenessMs),
    failureThreshold: normalizeNumber(body.failureThreshold),
  };
}

function normalizeTrigger(value: unknown): ScheduledWorkTrigger {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const kind = normalizeEnum(input.kind, ['cron', 'interval', 'once'], 'cron');
  const expression = normalizeString(input.expression);
  const timezone = normalizeString(input.timezone);
  if (!expression || !timezone) throw new Error('trigger expression and timezone are required');
  return { kind, expression, timezone };
}

function normalizeStatus(value: unknown): 'enabled' | 'paused' | 'retired' | undefined {
  return optionalEnum(value, ['enabled', 'paused', 'retired']);
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
  return 'Dispatch a preapproved feed-analysis request and track its result and callback evidence.';
}

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
