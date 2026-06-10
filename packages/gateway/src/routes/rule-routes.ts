import type { FastifyInstance } from 'fastify';
import {
  deleteRule,
  ensureRuleStore,
  listRules,
  loadRule,
  loadRulesFromDir,
  syncRulesToDir,
  updateRuleStatus,
  upsertRule,
  type RuleEnforcementMode,
  type RuleLayer,
  type RuleScope,
  type RuleSeverity,
  type RuleStatus,
} from '@los/agent/rules';

export function registerRuleRoutes(app: FastifyInstance, defaultWorkspaceRoot?: string) {
  app.get('/rules', async (req) => {
    const query = req.query as {
      status?: string;
      severity?: string;
      scope?: string;
      ruleLayer?: string;
      archived?: string;
    };
    await ensureRuleStore();
    return await listRules({
      status: normalizeRuleStatus(query.status),
      severity: normalizeRuleSeverity(query.severity),
      scope: normalizeScope(query.scope),
      ruleLayer: normalizeRuleLayer(query.ruleLayer),
      archived: query.archived === 'true' ? true : query.archived === 'false' ? false : undefined,
    });
  });

  app.get('/rules/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const query = req.query as { scope?: string };
    await ensureRuleStore();
    const rule = await loadRule(name, normalizeScope(query.scope));
    if (!rule) return reply.status(404).send({ error: 'Rule not found' });
    return rule;
  });

  app.post('/rules', async (req, reply) => {
    const body = req.body as {
      name?: string;
      severity?: string;
      enforcementMode?: string;
      status?: string;
      content?: string;
      scope?: string;
      ruleLayer?: string;
      metadata?: Record<string, unknown>;
    };

    const name = normalizeOptionalString(body.name);
    if (!name) return reply.status(400).send({ error: 'name is required' });
    if (!isSafeRegistryName(name)) return reply.status(400).send({ error: 'name must be a safe registry identifier' });

    const scope = normalizeScope(body.scope) ?? 'project';
    const ruleLayer = normalizeRuleLayer(body.ruleLayer) ?? defaultRuleLayer(scope);

    const metadata: Record<string, unknown> = { ...(body.metadata ?? {}) };
    metadata.scope = scope;
    metadata.ruleLayer = ruleLayer;
    if (metadata.archived === undefined) metadata.archived = false;

    await ensureRuleStore();
    const rule = await upsertRule({
      name,
      severity: normalizeRuleSeverity(body.severity),
      enforcementMode: normalizeEnforcementMode(body.enforcementMode),
      status: normalizeRuleStatus(body.status),
      content: normalizeOptionalString(body.content),
      metadata,
    });
    return reply.status(201).send(rule);
  });

  app.patch('/rules/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const query = req.query as { scope?: string };
    const body = req.body as { status?: string };
    const status = normalizeRuleStatus(body?.status);
    if (!status) return reply.status(400).send({ error: 'status is required' });

    await ensureRuleStore();
    const rule = await updateRuleStatus(name, status, normalizeScope(query.scope));
    if (!rule) return reply.status(404).send({ error: 'Rule not found' });
    return rule;
  });

  app.delete('/rules/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const query = req.query as { scope?: string };
    await ensureRuleStore();
    const ok = await deleteRule(name, normalizeScope(query.scope));
    if (!ok) return reply.status(404).send({ error: 'Rule not found' });
    return { ok: true };
  });

  // ── File Sync ──────────────────────────────────────────

  app.post('/rules/sync-to-dir', async (req) => {
    const body = req.body as { scope?: string; ruleLayer?: string; workspaceRoot?: string };
    const layer = normalizeRuleLayer(body.ruleLayer);
    const scope = layer === 'system' ? 'global' : normalizeScope(body.scope) ?? 'global';
    const ruleLayer = layer ?? defaultRuleLayer(scope);
    const workspaceRoot = normalizeOptionalString(body.workspaceRoot) ?? defaultWorkspaceRoot;
    await ensureRuleStore();
    const rules = await listRules({ scope, ruleLayer, status: 'active' });
    syncRulesToDir(scope, rules, workspaceRoot, ruleLayer);
    return { ok: true, count: rules.length, scope, ruleLayer };
  });

  app.post('/rules/load-from-dir', async (req, reply) => {
    const body = req.body as { scope?: string; ruleLayer?: string; workspaceRoot?: string };
    const layer = normalizeRuleLayer(body.ruleLayer);
    const scope = layer === 'system' ? 'global' : normalizeScope(body.scope) ?? 'global';
    const ruleLayer = layer ?? defaultRuleLayer(scope);
    const workspaceRoot = normalizeOptionalString(body.workspaceRoot) ?? defaultWorkspaceRoot;
    const loaded = loadRulesFromDir(scope, workspaceRoot, ruleLayer);
    await ensureRuleStore();
    const upserted = [];
    for (const item of loaded) {
      upserted.push(await upsertRule({
        name: item.name,
        content: item.content,
        severity: item.severity as RuleSeverity,
        enforcementMode: item.enforcementMode as RuleEnforcementMode,
        status: item.status as RuleStatus,
        metadata: item.metadata,
      }));
    }
    return reply.status(201).send({ ok: true, count: upserted.length, scope, ruleLayer, rules: upserted });
  });
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeScope(value: unknown): RuleScope | undefined {
  if (value === 'global' || value === 'project') return value;
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

function normalizeRuleLayer(value: unknown): RuleLayer | undefined {
  if (value === 'user' || value === 'project' || value === 'system') return value;
  return undefined;
}

function defaultRuleLayer(scope: RuleScope): RuleLayer {
  return scope === 'global' ? 'user' : 'project';
}

function isSafeRegistryName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) && value !== '.' && value !== '..';
}
