import type { FastifyInstance } from 'fastify';
import type { DiscoveredProvider } from '@los/infra/discovery';
import { discoverAll } from '@los/infra/discovery';
import {
  listLatestProviderCompatEvidence,
  listProviderCompatEvidence,
  listProviderPromotionDecisions,
  recordProviderPromotionDecision,
  enforceProviderPromotionDecision,
  importExternalToolSummary,
  listRunEvals,
  listExternalToolSummaries,
  recordEvalBacklogSnapshot,
  getEvalBacklogCases,
  recordRunEval,
  compareRunEvals,
  summarizeRunEvals,
} from '@los/agent';
import { describeProviderReadiness } from '@los/infra/discovery';
import {
  asRecord,
  normalizeOptionalString,
  normalizeBoundedInteger,
  normalizeStringArray,
  normalizeOptionalNonNegativeInteger,
  normalizeOptionalNonNegativeNumber,
  normalizeNonNegativeInteger,
  truncateForHttp,
  normalizeProviderSummaryStringArray,
  normalizeNonNegativeNumber,
  parseOptionalBoolean,
} from './server-helpers.js';
import { getConfig } from '@los/infra/config';

// ── Provider/onboarding sanitizers ──────────────────────

function sanitizeProviderDiscovery(provider: DiscoveredProvider, compatEvidence: Array<{
  provider?: string; model?: string; verdict?: string; summary?: Record<string, unknown>;
}>): Record<string, unknown> {
  const evidenceForProvider = compatEvidence.filter(e => e.provider === provider.name);
  const latestVerdict = evidenceForProvider.at(0)?.verdict;
  const readiness = describeProviderReadiness(provider);
  return {
    name: provider.name,
    displayName: (provider as any).displayName ?? provider.name,
    defaultModel: provider.defaultModel,
    available: provider.available,
    source: provider.source,
    readiness,
    compatEvidence: {
      count: evidenceForProvider.length,
      latestVerdict: latestVerdict ?? null,
      latest: evidenceForProvider.at(0) ?? null,
    },
  };
}

function sanitizeProviderCompatEvidence(item: {
  id: string;
  provider: string;
  model?: string;
  probeId: string;
  targetLabel: string;
  decision: string;
  passed: boolean;
  sessionId?: string;
  taskRunId?: string;
  runSpecId?: string;
  traceId?: string;
  requestId?: string;
  nodeId?: string;
  totalTokens: number;
  summary: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}): Record<string, unknown> {
  return {
    id: item.id,
    provider: item.provider,
    model: item.model ?? null,
    probeId: item.probeId,
    targetLabel: item.targetLabel,
    decision: item.decision,
    passed: item.passed,
    sessionId: item.sessionId ?? null,
    taskRunId: item.taskRunId ?? null,
    runSpecId: item.runSpecId ?? null,
    traceId: item.traceId ?? null,
    requestId: item.requestId ?? null,
    nodeId: item.nodeId ?? null,
    totalTokens: item.totalTokens,
    summary: sanitizeProviderCompatSummary(item.summary),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function sanitizeProviderCompatSummary(summary: Record<string, unknown>): Record<string, unknown> {
  return {
    completed: summary.completed === true,
    cancelled: summary.cancelled === true,
    reasoningObserved: summary.reasoningObserved === true,
    toolCalls: normalizeProviderSummaryStringArray(summary.toolCalls, 12),
    toolResultCount: normalizeNonNegativeNumber(summary.toolResultCount),
    failedToolResultCount: normalizeNonNegativeNumber(summary.failedToolResultCount),
    deniedToolCount: normalizeNonNegativeNumber(summary.deniedToolCount),
    failures: normalizeProviderSummaryStringArray(summary.failures, 8).map(failure => truncateForHttp(failure, 240)),
  };
}

type RunEvalQuery = {
  runSpecId?: string; sessionId?: string; taskRunId?: string;
  provider?: string; model?: string; success?: string;
  verificationStatus?: string; failureClass?: string; failoverScope?: string;
  createdFrom?: string; createdTo?: string;
  baselineFrom?: string; baselineTo?: string;
  candidateFrom?: string; candidateTo?: string;
  limit?: string;
};
function parseRunEvalQuery(query: RunEvalQuery): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const strFields = ['runSpecId', 'sessionId', 'taskRunId', 'provider', 'model',
    'verificationStatus', 'failureClass', 'failoverScope',
    'createdFrom', 'createdTo', 'baselineFrom', 'baselineTo', 'candidateFrom', 'candidateTo'];
  for (const f of strFields) {
    const v = normalizeOptionalString((query as any)[f]);
    if (v) out[f] = v;
  }
  if (query.success === 'true') out.success = true;
  else if (query.success === 'false') out.success = false;
  out.limit = normalizeBoundedInteger(query.limit, 100, 1, 1000);
  return out;
}

function parseProviderPromotionAction(value: unknown): 'promote_required' | 'demote_advisory' {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === 'promote_required' || trimmed === 'demote_advisory') return trimmed;
  }
  return 'demote_advisory';
}

// ── Route registration ─────────────────────────────────

export function registerProviderRoutes(app: FastifyInstance): void {
  app.get('/onboarding', async () => {
    const report = await discoverAll();
    const compatEvidence = await listLatestProviderCompatEvidence().catch(() => []);
    return {
      ...report,
      providers: report.providers.map(provider => sanitizeProviderDiscovery(provider, compatEvidence)),
    };
  });

  app.get('/providers/compat-evidence', async (req) => {
    const query = req.query as { provider?: string; model?: string; limit?: string };
    const evidence = await listProviderCompatEvidence({
      provider: normalizeOptionalString(query.provider),
      model: normalizeOptionalString(query.model),
      limit: normalizeBoundedInteger(query.limit, 100, 1, 1000),
    });
    return { count: evidence.length, evidence: evidence.map(sanitizeProviderCompatEvidence) };
  });

  app.get('/providers/promotion-decisions', async (req) => {
    const query = req.query as { provider?: string; model?: string; limit?: string };
    const decisions = await listProviderPromotionDecisions({
      provider: normalizeOptionalString(query.provider),
      model: normalizeOptionalString(query.model),
      limit: normalizeBoundedInteger(query.limit, 100, 1, 1000),
    });
    return { count: decisions.length, decisions };
  });

  app.post('/providers/promotion-decisions', async (req, reply) => {
    const body = asRecord(req.body);
    try {
      const decision = await recordProviderPromotionDecision({
        action: parseProviderPromotionAction(body.action),
        provider: normalizeOptionalString(body.provider),
        model: normalizeOptionalString(body.model),
        probeId: normalizeOptionalString(body.probeId),
        targetLabel: normalizeOptionalString(body.targetLabel),
        evidenceId: normalizeOptionalString(body.evidenceId),
        reason: normalizeOptionalString(body.reason) ?? '',
        actor: normalizeOptionalString(body.actor),
      });
      return { decision };
    } catch (err) {
      return reply.status(422).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/providers/promotion-decisions/enforce', async (req, reply) => {
    const body = asRecord(req.body);
    try {
      const decision = await enforceProviderPromotionDecision({
        id: normalizeOptionalString(body.id) ?? '',
        actor: normalizeOptionalString(body.actor),
      });
      return { decision };
    } catch (err) {
      return reply.status(422).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/external-summaries', async (req) => {
    const query = req.query as { tool?: string; sourceKind?: string; limit?: string; includeExpired?: string };
    const summaries = await listExternalToolSummaries({
      tool: normalizeOptionalString(query.tool),
      sourceKind: normalizeOptionalString(query.sourceKind),
      limit: normalizeBoundedInteger(query.limit, 100, 1, 1000),
      includeExpired: query.includeExpired === 'true',
    });
    return { count: summaries.length, summaries };
  });

  app.post('/external-summaries', async (req, reply) => {
    try {
      const summary = await importExternalToolSummary(req.body as never);
      return reply.status(201).send({ summary });
    } catch (err) {
      return reply.status(422).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/run-evals/summary', async (req, reply) => {
    const query = parseRunEvalQuery(req.query as RunEvalQuery);
    try {
      const summary = await summarizeRunEvals(query);
      return summary;
    } catch (err) {
      return reply.status(422).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/run-evals/compare', async (req, reply) => {
    const query = req.query as RunEvalQuery;
    const baselineFrom = normalizeOptionalString(query.baselineFrom);
    const baselineTo = normalizeOptionalString(query.baselineTo);
    const candidateFrom = normalizeOptionalString(query.candidateFrom);
    const candidateTo = normalizeOptionalString(query.candidateTo);
    if (!baselineFrom || !baselineTo || !candidateFrom || !candidateTo) {
      return reply.status(400).send({ error: 'baselineFrom, baselineTo, candidateFrom, and candidateTo are required' });
    }
    try {
      const result = await compareRunEvals({ baselineFrom, baselineTo, candidateFrom, candidateTo });
      return result;
    } catch (err) {
      return reply.status(422).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/run-evals', async (req) => {
    const query = parseRunEvalQuery(req.query as RunEvalQuery);
    const evals = await listRunEvals(query);
    return { count: evals.length, evals };
  });

  app.post('/run-evals', async (req, reply) => {
    const body = asRecord(req.body);
    const success = parseOptionalBoolean(body.success);
    if (success === undefined) return reply.status(422).send({ error: 'success is required' });
    const failoverScope = normalizeOptionalString(body.failoverScope);
    if (failoverScope !== undefined && failoverScope !== 'service' && failoverScope !== 'executor') {
      return reply.status(422).send({ error: 'failoverScope must be service, executor, or omitted' });
    }
    try {
      const evaluation = await recordRunEval({
        id: normalizeOptionalString(body.id),
        runSpecId: normalizeOptionalString(body.runSpecId) ?? '',
        sessionId: normalizeOptionalString(body.sessionId),
        taskRunId: normalizeOptionalString(body.taskRunId),
        provider: normalizeOptionalString(body.provider),
        model: normalizeOptionalString(body.model),
        success,
        latencyMs: normalizeOptionalNonNegativeInteger(body.latencyMs),
        retryCount: normalizeOptionalNonNegativeInteger(body.retryCount),
        toolErrorCount: normalizeOptionalNonNegativeInteger(body.toolErrorCount),
        verificationStatus: normalizeOptionalString(body.verificationStatus),
        modelCost: normalizeOptionalNonNegativeNumber(body.modelCost),
        userFeedback: normalizeOptionalString(body.userFeedback),
        failureClass: normalizeOptionalString(body.failureClass),
        failoverScope: normalizeOptionalString(body.failoverScope),
        summary: asRecord(body.summary),
      });
      return reply.status(201).send({ eval: evaluation });
    } catch (err) {
      return reply.status(422).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Eval backlog ─────────────────────────────────────
  app.post('/eval-backlog/run', async (_req, reply) => {
    try {
      const snapshot = await recordEvalBacklogSnapshot({ triggeredBy: 'gateway' });
      return reply.status(201).send({ ok: true, snapshot });
    } catch (err) {
      return reply.status(422).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/eval-backlog', async (_req) => {
    const { getDb } = await import('@los/infra/db');
    const rows = await getDb().query<{
      id: string; run_spec_id: string; provider: string; model: string;
      success: boolean; verification_status: string; summary_json: Record<string, unknown>;
      updated_at: string;
    }>(
      `SELECT DISTINCT ON (run_spec_id, id) id, run_spec_id, provider, model,
              success, verification_status, summary_json, updated_at
       FROM run_evals
       WHERE run_spec_id = 'eval-backlog'
       ORDER BY run_spec_id, id, updated_at DESC`,
    );
    const cases = rows.rows.map(r => ({
      id: r.id,
      success: r.success,
      verificationStatus: r.verification_status,
      summary: r.summary_json,
      updatedAt: r.updated_at,
    }));
    return { count: cases.length, cases, backlogCases: getEvalBacklogCases() };
  });

  app.get('/providers/models', async (req) => {
    const query = req.query as { provider?: string; model?: string; q?: string };
    const providerFilter = normalizeOptionalString(query.provider);
    const modelFilter = normalizeOptionalString(query.model);
    const search = normalizeOptionalString(query.q);
    const config = getConfig();
    const modelSet = new Map<string, { provider: string; model: string; source: string; enabled: boolean }>();
    const discoveryReport = await discoverAll().catch(() => ({ providers: [] }));
    for (const dp of discoveryReport.providers) {
      if (!dp.available) continue;
      const key = `${dp.name}::${dp.defaultModel ?? '*'}`;
      if (modelSet.has(key)) continue;
      modelSet.set(key, {
        provider: dp.name,
        model: dp.defaultModel ?? 'unknown',
        source: dp.source ?? 'discovery',
        enabled: true,
      });
    }
    for (const [name, p] of Object.entries(config.providers)) {
      const model = p.model ?? 'default';
      const key = `${name}::${model}`;
      modelSet.set(key, {
        provider: name,
        model,
        source: p.source ?? 'config',
        enabled: p.enabled ?? false,
      });
    }
    let results = [...modelSet.values()];
    if (providerFilter) results = results.filter(r => r.provider === providerFilter);
    if (modelFilter) results = results.filter(r => r.model === modelFilter);
    if (search) {
      const s = search.toLowerCase();
      results = results.filter(r => r.provider.toLowerCase().includes(s) || r.model.toLowerCase().includes(s));
    }
    return { count: results.length, models: results };
  });
}
