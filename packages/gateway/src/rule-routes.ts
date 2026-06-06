import type { FastifyInstance } from 'fastify';
import {
  deleteRule,
  ensureRuleStore,
  listRules,
  loadRule,
  updateRuleStatus,
  upsertRule,
  type RuleEnforcementMode,
  type RuleScope,
  type RuleSeverity,
  type RuleStatus,
} from '@los/agent/rules';

export function registerRuleRoutes(app: FastifyInstance) {
  app.get('/rules', async (req) => {
    const query = req.query as { scope?: string; status?: string; severity?: string };
    await ensureRuleStore();
    return await listRules({
      scope: normalizeRuleScope(query.scope),
      status: normalizeRuleStatus(query.status),
      severity: normalizeRuleSeverity(query.severity),
    });
  });

  app.get('/rules/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    await ensureRuleStore();
    const rule = await loadRule(name);
    if (!rule) return reply.status(404).send({ error: 'Rule not found' });
    return rule;
  });

  app.post('/rules', async (req, reply) => {
    const body = req.body as {
      name?: string;
      scope?: string;
      severity?: string;
      enforcementMode?: string;
      status?: string;
      content?: string;
      attachedSessions?: string[];
      attachedTasks?: string[];
      metadata?: Record<string, unknown>;
    };

    const name = normalizeOptionalString(body.name);
    if (!name) return reply.status(400).send({ error: 'name is required' });

    await ensureRuleStore();
    const rule = await upsertRule({
      name,
      scope: normalizeRuleScope(body.scope),
      severity: normalizeRuleSeverity(body.severity),
      enforcementMode: normalizeEnforcementMode(body.enforcementMode),
      status: normalizeRuleStatus(body.status),
      content: normalizeOptionalString(body.content),
      attachedSessions: body.attachedSessions,
      attachedTasks: body.attachedTasks,
      metadata: body.metadata,
    });
    return reply.status(201).send(rule);
  });

  app.patch('/rules/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const body = req.body as { status?: string };
    const status = normalizeRuleStatus(body?.status);
    if (!status) return reply.status(400).send({ error: 'status is required' });

    await ensureRuleStore();
    const rule = await updateRuleStatus(name, status);
    if (!rule) return reply.status(404).send({ error: 'Rule not found' });
    return rule;
  });

  app.delete('/rules/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    await ensureRuleStore();
    const ok = await deleteRule(name);
    if (!ok) return reply.status(404).send({ error: 'Rule not found' });
    return { ok: true };
  });
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeRuleScope(value: unknown): RuleScope | undefined {
  if (value === 'global' || value === 'project' || value === 'user') return value;
  return undefined;
}

function normalizeRuleSeverity(value: unknown): RuleSeverity | undefined {
  if (value === 'info' || value === 'warn' || value === 'error' || value === 'block') return value;
  return undefined;
}

function normalizeEnforcementMode(value: unknown): RuleEnforcementMode | undefined {
  if (value === 'advisory' || value === 'required') return value;
  return undefined;
}

function normalizeRuleStatus(value: unknown): RuleStatus | undefined {
  if (value === 'active' || value === 'inactive' || value === 'draft') return value;
  return undefined;
}
