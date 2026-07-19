/**
 * Provider evidence & eval routes — compat evidence, promotion decisions,
 * external summaries, run evals, eval backlog.
 * Extracted from provider-routes.ts to keep each file under 400 lines.
 */
import type { FastifyInstance } from 'fastify';
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
  listPairwiseRunEvals,
  recordPairwiseRunEval,
  recordRunEval,
  compareRunEvals,
  summarizeRunEvals,
} from '@los/agent';
import {
  asRecord,
  normalizeOptionalString,
  normalizeBoundedInteger,
  normalizeOptionalNonNegativeInteger,
  normalizeOptionalNonNegativeNumber,
  parseOptionalBoolean,
} from '../server-helpers.js';
import {
  sanitizeProviderDiscovery,
  sanitizeProviderCompatEvidence,
  parseRunEvalQuery,
  parseProviderPromotionAction,
  type RunEvalQuery,
} from './provider-helpers.js';
import { getOperatorPrincipal, requireOperator } from '../../request-context.js';

export function registerProviderEvidenceRoutes(app: FastifyInstance): void {
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
    if (!(await requireOperator(req, reply))) return;
    const operator = getOperatorPrincipal(req);
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
        actor: operator.subject,
      });
      return { decision };
    } catch (err) {
      return reply.status(422).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/providers/promotion-decisions/enforce', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const operator = getOperatorPrincipal(req);
    const body = asRecord(req.body);
    try {
      const decision = await enforceProviderPromotionDecision({
        id: normalizeOptionalString(body.id) ?? '',
        actor: operator.subject,
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

  app.get('/run-evals/pairwise', async (req) => {
    const query = req.query as { pairId?: string; experimentId?: string; verdict?: string; limit?: string };
    const verdict = normalizeOptionalString(query.verdict);
    const allowedVerdicts = new Set(['baseline', 'candidate', 'tie', 'inconclusive']);
    const evals = await listPairwiseRunEvals({
      pairId: normalizeOptionalString(query.pairId),
      experimentId: normalizeOptionalString(query.experimentId),
      verdict: verdict && allowedVerdicts.has(verdict) ? verdict as never : undefined,
      limit: normalizeBoundedInteger(query.limit, 100, 1, 500),
    });
    return { count: evals.length, evals };
  });

  app.get('/run-evals/pairwise/:pairId', async (req, reply) => {
    const pairId = normalizeOptionalString((req.params as { pairId?: string }).pairId);
    if (!pairId) return reply.status(400).send({ error: 'pairId is required' });
    try {
      const evals = await listPairwiseRunEvals(pairId);
      return { count: evals.length, evals };
    } catch (err) {
      return reply.status(422).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/run-evals/pairwise', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const body = asRecord(req.body);
    const metrics = asRecord(body.metrics);
    const success = parseOptionalBoolean(metrics.success);
    try {
      const evaluation = await recordPairwiseRunEval({
        id: normalizeOptionalString(body.id),
        pairId: normalizeOptionalString(body.pairId),
        experimentId: normalizeOptionalString(body.experimentId) ?? '',
        baselineRunSpecId: normalizeOptionalString(body.baselineRunSpecId) ?? '',
        candidateRunSpecId: normalizeOptionalString(body.candidateRunSpecId) ?? '',
        rubricRevision: normalizeOptionalString(body.rubricRevision) ?? '',
        rubricSnapshot: asRecord(body.rubricSnapshot) as never,
        verdict: normalizeOptionalString(body.verdict) as never,
        human: body.human === undefined ? undefined : asRecord(body.human) as never,
        judge: body.judge === undefined ? undefined : asRecord(body.judge) as never,
        deterministic: body.deterministic === undefined ? undefined : asRecord(body.deterministic) as never,
        runSpecId: normalizeOptionalString(metrics.runSpecId),
        sessionId: normalizeOptionalString(metrics.sessionId),
        taskRunId: normalizeOptionalString(metrics.taskRunId),
        provider: normalizeOptionalString(metrics.provider),
        model: normalizeOptionalString(metrics.model),
        success,
        latencyMs: normalizeOptionalNonNegativeInteger(metrics.latencyMs),
        retryCount: normalizeOptionalNonNegativeInteger(metrics.retryCount),
        toolErrorCount: normalizeOptionalNonNegativeInteger(metrics.toolErrorCount),
        verificationStatus: normalizeOptionalString(metrics.verificationStatus),
        modelCost: normalizeOptionalNonNegativeNumber(metrics.modelCost),
        summary: asRecord(metrics.summary),
      });
      return reply.status(201).send({ eval: evaluation });
    } catch (err) {
      return reply.status(422).send({ error: err instanceof Error ? err.message : String(err) });
    }
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
      id: r.id, success: r.success, verificationStatus: r.verification_status,
      summary: r.summary_json, updatedAt: r.updated_at,
    }));
    return { count: cases.length, cases, backlogCases: getEvalBacklogCases() };
  });
}
