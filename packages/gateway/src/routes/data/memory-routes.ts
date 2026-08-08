import type { FastifyInstance } from 'fastify';
import {
  ensureMemoryStore, addObservation, searchObservations,
  getStats, deleteObservation, updateObservation, getObservation,
  ensureMemoryCompactionStore, compactSession, listCompactions,
  retrieveActiveRules, routeMemoryRetrieval,
  applyRetentionPolicy, checkMemoryIntegrity,
  getLatestCheckpoint,
} from '@los/memory';
import { syncMemoryMd } from '@los/memory';
import {
  resolveMemoryScope,
  normalizeScope,
  canAccessMemory,
  canWriteToScope,
  canDeleteMemory,
  evaluatePromotion,
  validateMemoryWrite,
  detectPoisoning,
  isMemoryWriteError,
  type MemoryScope,
  type MemoryAccessContext,
} from '@los/memory';
import { ensureRunEvalStore } from '@los/agent';
import { ensureTaskRunStore } from '@los/agent/task-runs';
import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import { getRequestContext } from '../../request-context.js';
import {
  normalizeOptionalString,
  normalizeStringArray,
  normalizeMemoryMetadata,
  parseOptionalBoolean,
  normalizeBoundedInteger,
} from '../server-helpers.js';

type MemoryRouteDependencies = {
  addObservation: typeof addObservation;
  applyRetentionPolicy: typeof applyRetentionPolicy;
  canDeleteMemory: typeof canDeleteMemory;
  canWriteToScope: typeof canWriteToScope;
  checkMemoryIntegrity: typeof checkMemoryIntegrity;
  compactSession: typeof compactSession;
  deleteObservation: typeof deleteObservation;
  ensureMemoryCompactionStore: typeof ensureMemoryCompactionStore;
  ensureMemoryStore: typeof ensureMemoryStore;
  ensureRunEvalStore: typeof ensureRunEvalStore;
  ensureTaskRunStore: typeof ensureTaskRunStore;
  evaluatePromotion: typeof evaluatePromotion;
  getLatestCheckpoint: typeof getLatestCheckpoint;
  getObservation: typeof getObservation;
  getStats: typeof getStats;
  listCompactions: typeof listCompactions;
  resolveMemoryScope: typeof resolveMemoryScope;
  retrieveActiveRules: typeof retrieveActiveRules;
  routeMemoryRetrieval: typeof routeMemoryRetrieval;
  searchObservations: typeof searchObservations;
  syncMemoryMd: typeof syncMemoryMd;
  updateObservation: typeof updateObservation;
};
const defaultDependencies: MemoryRouteDependencies = {
  addObservation,
  applyRetentionPolicy,
  canDeleteMemory,
  canWriteToScope,
  checkMemoryIntegrity,
  compactSession,
  deleteObservation,
  ensureMemoryCompactionStore,
  ensureMemoryStore,
  ensureRunEvalStore,
  ensureTaskRunStore,
  evaluatePromotion,
  getLatestCheckpoint,
  getObservation,
  getStats,
  listCompactions,
  resolveMemoryScope,
  retrieveActiveRules,
  routeMemoryRetrieval,
  searchObservations,
  syncMemoryMd,
  updateObservation,
};

const log = getLogger('memory-routes');

/** Build an access context from the request context, sessionId, and target scope.
 *  Operator status is taken from the validated RequestContext (gated on operatorToken),
 *  NOT from the forgeable x-los-role header. */
function buildAccessContext(
  deps: { resolveMemoryScope: typeof resolveMemoryScope },
  req: { headers: Record<string, string | string[] | undefined> },
  targetScope: MemoryScope,
  opts: { sessionId?: string | null; targetSessionId?: string | null; targetProjectId?: string | null; targetUserId?: string | null } = {},
): MemoryAccessContext {
  const ctx = getRequestContext(req as any);
  const reqScope = deps.resolveMemoryScope({
    sessionId: opts?.sessionId,
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    userId: ctx.userId,
  });
  return {
    requesterScope: reqScope,
    targetScope,
    isOperator: ctx.isOperator,
    sameSession: opts?.targetSessionId ? (opts?.targetSessionId === opts?.sessionId) : undefined,
    sameProject: opts?.targetProjectId ? (opts.targetProjectId === ctx.projectId) : undefined,
    sameUser: opts?.targetUserId ? (opts.targetUserId === ctx.userId) : undefined,
  };
}
export function registerMemoryRoutes(
  app: FastifyInstance,
  deps: MemoryRouteDependencies = defaultDependencies,
): void {
  app.get('/memory', async (req) => {
    const ctx = getRequestContext(req);
    const query = req.query as {
      q?: string; kind?: string; source?: string; tag?: string; scope?: string;
      memoryLayer?: string; archived?: string; sessionId?: string;
      tenantId?: string; projectId?: string; userId?: string;
      requestId?: string; traceId?: string; limit?: string;
    };
    await deps.ensureMemoryStore();

    // ACL enforcement: if auth is enabled, scope read results to the caller's
    // tenant/project/user context. Operator can see everything.
    const effectiveTenantId = ctx.isOperator ? (query.tenantId ?? undefined) : (query.tenantId ?? ctx.tenantId);
    const effectiveProjectId = ctx.isOperator ? (query.projectId ?? undefined) : (query.projectId ?? ctx.projectId);
    const effectiveUserId = ctx.isOperator ? (query.userId ?? undefined) : (query.userId ?? ctx.userId);

    const results = await deps.searchObservations(query.q ?? '', {
      kind: query.kind,
      source: query.source,
      tag: query.tag,
      scope: query.scope,
      memoryLayer: query.memoryLayer,
      archived: parseOptionalBoolean(query.archived),
      sessionId: query.sessionId,
      tenantId: effectiveTenantId,
      projectId: effectiveProjectId,
      userId: effectiveUserId,
      requestId: query.requestId,
      traceId: query.traceId,
      limit: normalizeBoundedInteger(query.limit, 20, 1, 200),
    });
    return { count: results.length, results };
  });

  app.post('/memory', async (req, reply) => {
    const { title, summary, kind, tags, content, metadata, source, sessionId, nodeId, scope: requestedScope } = req.body as any;
    const context = getRequestContext(req);
    await deps.ensureMemoryStore();

    // Write gate: structural/source constraints before any DB work (422, not 500)
    const normalizedSessionId = normalizeOptionalString(sessionId);
    const violations = validateMemoryWrite({
      title,
      summary,
      kind,
      tags: normalizeStringArray(tags),
      content,
      metadata,
      source,
      sessionId: normalizedSessionId,
      nodeId: normalizeOptionalString(nodeId),
    });
    if (violations.length > 0) {
      return reply.status(422).send({
        error: 'Unprocessable Entity',
        detail: 'Memory write rejected by write gate',
        violations,
      });
    }

    // Scope enforcement: caller must be able to write at the requested scope
    const targetScope = normalizeScope(requestedScope ?? 'session');
    const acl = buildAccessContext(deps, req, targetScope, { sessionId: sessionId });
    if (!deps.canWriteToScope(acl)) {
      return reply.status(403).send({
        error: 'Forbidden',
        detail: `Scope ${acl.requesterScope} cannot write to ${targetScope} scope`,
        requiredScope: targetScope,
        yourScope: acl.requesterScope,
      });
    }

    let obs;
    try {
      obs = await deps.addObservation({
        title, summary, kind,
        tags: normalizeStringArray(tags),
        content,
        source,
        metadata: normalizeMemoryMetadata(metadata, {
          scope: targetScope,
          memoryLayer: metadata?.memoryLayer ?? 'episodic',
          archived: false,
          observerType: metadata?.observerType ?? 'user',
        }),
        sessionId: normalizedSessionId,
        tenantId: context.tenantId,
        projectId: context.projectId,
        userId: context.userId,
        nodeId: normalizeOptionalString(nodeId),
        requestId: context.requestId,
        traceId: context.traceId,
      });
    } catch (err) {
      // Store-layer write gate (defense in depth) → 422 like the pre-check
      if (isMemoryWriteError(err)) {
        return reply.status(422).send({
          error: 'Unprocessable Entity',
          detail: 'Memory write rejected by write gate',
          violations: err.violations,
        });
      }
      throw err;
    }
    // Surface poisoning auto-flag when content matched an injection pattern
    const poisonFlag = (obs.metadata as Record<string, unknown>).poisonFlag;
    return poisonFlag ? { ...obs, poisoning: poisonFlag } : obs;
  });

  app.patch('/memory/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as any;
    await deps.ensureMemoryStore();
    // Write gate: structural/source constraints on the patch payload (422, not 500)
    const violations = validateMemoryWrite({
      title: normalizeOptionalString(body.title),
      summary: normalizeOptionalString(body.summary),
      kind: normalizeOptionalString(body.kind),
      tags: body.tags === undefined ? undefined : normalizeStringArray(body.tags),
      content: normalizeOptionalString(body.content),
      metadata: body.metadata === undefined ? undefined : normalizeMemoryMetadata(body.metadata),
    }, { partial: true });
    if (violations.length > 0) {
      return reply.status(422).send({
        error: 'Unprocessable Entity',
        detail: 'Memory write rejected by write gate',
        violations,
      });
    }
    const obs = await deps.updateObservation(parseInt(id), {
      title: normalizeOptionalString(body.title),
      summary: normalizeOptionalString(body.summary),
      kind: normalizeOptionalString(body.kind),
      tags: body.tags === undefined ? undefined : normalizeStringArray(body.tags),
      content: normalizeOptionalString(body.content),
      metadata: body.metadata === undefined ? undefined : normalizeMemoryMetadata(body.metadata),
    });
    if (!obs) {
      reply.code(404);
      return { error: 'Not found' };
    }
    return obs;
  });

  app.delete('/memory/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await deps.ensureMemoryStore();
    const existing = await deps.getObservation(parseInt(id));
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    // Caller sessionId from query param — needed for sameSession check on
    // session-scoped observations. Without it, session-scoped delete is denied
    // unless the caller has a higher scope or is an operator.
    const callerSessionId = (req.query as { sessionId?: string }).sessionId ?? null;

    // Scope enforcement: can the caller delete at the observation's scope?
    const targetScope = normalizeScope(existing.metadata.scope as string);
    const acl: MemoryAccessContext = {
      ...buildAccessContext(deps, req, targetScope, {
        sessionId: callerSessionId,
        targetSessionId: existing.sessionId,
        targetProjectId: existing.projectId,
        targetUserId: existing.userId,
      }),
    };
    if (!deps.canDeleteMemory(acl)) {
      return reply.status(403).send({
        error: 'Forbidden',
        detail: `Cannot delete observation at scope ${targetScope} from scope ${acl.requesterScope}`,
        observationScope: targetScope,
        yourScope: acl.requesterScope,
      });
    }

    const ok = await deps.deleteObservation(parseInt(id));
    return { ok };
  });

  app.get('/memory/stats', async () => {
    await deps.ensureMemoryStore();
    return await deps.getStats();
  });

  app.post('/memory/compact', async (req, reply) => {
    const body = req.body as { sessionId?: string; runSpecId?: string };
    const sessionId = normalizeOptionalString(body.sessionId);
    if (!sessionId) return reply.status(422).send({ error: 'sessionId is required' });
    const context = getRequestContext(req);
    await deps.ensureMemoryCompactionStore();
    await deps.ensureRunEvalStore();
    await deps.ensureTaskRunStore();
    const compaction = await deps.compactSession({
      sessionId,
      runSpecId: normalizeOptionalString(body.runSpecId),
      tenantId: context.tenantId,
      projectId: context.projectId,
      createdBy: context.userId ?? context.requestId,
      // Pre/post hooks: checkpoint before compaction, context rebuild after
      onPreCompact: async (preCtx) => {
        log.info(`Compaction starting for session ${preCtx.sessionId} (mode=${preCtx.mode}, trigger=${preCtx.trigger ?? 'manual'})`);
      },
      onPostCompact: async (postCtx) => {
        log.info(`Compaction complete for session ${postCtx.sessionId}: ${postCtx.observationCount} obs, ${postCtx.taskRunCount} tasks, ${postCtx.evalCount} evals, ${postCtx.proceduralCandidateCount} candidates, confidence=${postCtx.confidence.toFixed(2)}`);
      },
    });
    return { compaction };
  });

  app.get('/memory/compactions', async (req) => {
    const query = req.query as { sessionId?: string; runSpecId?: string; limit?: string };
    const context = getRequestContext(req);
    await deps.ensureMemoryCompactionStore();
    const compactions = await deps.listCompactions({
      sessionId: normalizeOptionalString(query.sessionId),
      runSpecId: normalizeOptionalString(query.runSpecId),
      tenantId: context.tenantId,
      projectId: context.projectId,
      limit: normalizeBoundedInteger(query.limit, 100, 1, 1000),
    });
    return { count: compactions.length, compactions };
  });

  // Checkpoint recovery: get the latest checkpoint for a session
  app.get('/memory/checkpoint/:sessionId', async (req) => {
    const { sessionId } = req.params as { sessionId: string };
    if (!sessionId) return { checkpoint: null };
    const checkpoint = await deps.getLatestCheckpoint(sessionId);
    return { checkpoint };
  });

  app.get('/memory/active-rules', async (req) => {
    const query = req.query as { runSpecId?: string; limit?: string };
    const context = getRequestContext(req);
    await deps.ensureMemoryCompactionStore();
    const rules = await deps.retrieveActiveRules({
      runSpecId: normalizeOptionalString(query.runSpecId),
      tenantId: context.tenantId,
      projectId: context.projectId,
      limit: normalizeBoundedInteger(query.limit, 50, 1, 200),
    });
    return { count: rules.length, rules };
  });

  app.post('/memory/retrieve', async (req) => {
    const body = req.body as {
      taskState?: string; runPhase?: string; sessionId?: string;
      runSpecId?: string; maxObservationsPerLayer?: string;
    };
    const context = getRequestContext(req);
    await deps.ensureMemoryStore();
    await deps.ensureMemoryCompactionStore();
    const result = await deps.routeMemoryRetrieval({
      taskState: normalizeOptionalString(body.taskState) as any,
      runPhase: normalizeOptionalString(body.runPhase),
      sessionId: normalizeOptionalString(body.sessionId),
      runSpecId: normalizeOptionalString(body.runSpecId),
      tenantId: context.tenantId,
      projectId: context.projectId,
      maxObservationsPerLayer: normalizeBoundedInteger(body.maxObservationsPerLayer, 5, 1, 20),
    });
    return result;
  });

  app.post('/memory/sync-md', async (req) => {
    const body = req.body as {
      workspaceRoot: string; scope?: string; memoryLayer?: string;
      archived?: boolean; projectId?: string;
    };
    await deps.ensureMemoryStore();
    const observations = await deps.searchObservations('', {
      limit: 50,
      scope: body.scope,
      memoryLayer: body.memoryLayer,
      archived: body.archived,
      projectId: body.projectId,
    });
    deps.syncMemoryMd(body.workspaceRoot, observations);
    return { ok: true, count: observations.length };
  });

  app.post('/memory/retention', async (req) => {
    const body = req.body as { dryRun?: boolean };
    if (body.dryRun) {
      // For dry-run, just report what would happen without applying
      const stats = await deps.getStats();
      return { dryRun: true, totalObservations: stats.totalObservations, archived: stats.archived };
    }
    const result = await deps.applyRetentionPolicy();
    return { ok: true, ...result };
  });

  app.get('/memory/integrity', async () => {
    const report = await deps.checkMemoryIntegrity();
    return report;
  });

  // Auto-compact: find uncompacted sessions (>1h old) and compact them.
  // Called by the scheduler or governance sweeper periodically.
  app.post('/memory/auto-compact', async () => {
    await deps.ensureMemoryStore();
    await deps.ensureMemoryCompactionStore();
    await deps.ensureRunEvalStore();
    await deps.ensureTaskRunStore();

    const db = getDb();
    const rows = await db.query<{ session_id: string }>(
      `SELECT DISTINCT o.session_id
       FROM observations o
       LEFT JOIN memory_compactions mc ON o.session_id = mc.session_id
       WHERE o.session_id IS NOT NULL
         AND mc.id IS NULL
         AND o.created_at < now() - INTERVAL '1 hour'
       LIMIT 10`,
    );

    const sessionIds = rows.rows.map(r => r.session_id).filter(Boolean);
    if (sessionIds.length === 0) {
      return { compacted: 0, detail: 'No uncompacted sessions found' };
    }

    const compacted: string[] = [];
    const errors: Array<{ sessionId: string; error: string }> = [];

    for (const sessionId of sessionIds) {
      try {
        const result = await deps.compactSession({ sessionId });
        if (result) {
          compacted.push(sessionId);
        }
      } catch (err) {
        errors.push({ sessionId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    log.info(`Auto-compacted ${compacted.length} session(s)${errors.length > 0 ? `, ${errors.length} error(s)` : ''}`);
    return { compacted: compacted.length, compactedSessionIds: compacted, errors };
  });

  // Promote an observation to the next scope level.
  app.post('/memory/:id/promote', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = getRequestContext(req);
    await deps.ensureMemoryStore();
    const obs = await deps.getObservation(parseInt(id));
    if (!obs) return reply.status(404).send({ error: 'Not found' });

    const fromScope = normalizeScope(obs.metadata.scope as string);
    const evidence = {
      fromScope,
      crossSessionEvidence: Number(obs.metadata.crossSessionEvidence ?? 0),
      crossProjectEvidence: Number(obs.metadata.crossProjectEvidence ?? 0),
      crossUserEvidence: Number(obs.metadata.crossUserEvidence ?? 0),
      compactionAttested: obs.metadata.compactionAttested === true || obs.metadata.attested === true,
      operatorApproved: ctx.isOperator,
      daysSinceCreation: (Date.now() - new Date(obs.createdAt).getTime()) / (1000 * 60 * 60 * 24),
      kind: obs.kind,
    };

    const decision = deps.evaluatePromotion(fromScope, evidence);
    if (!decision.allowed) {
      return reply.status(422).send({
        error: 'Promotion denied',
        reason: decision.reason,
        gate: decision.gate,
        requiredCallerScope: decision.requiredCallerScope,
      });
    }

    // Scope enforcement: caller must meet the required scope for this gate
    const acl = buildAccessContext(deps, req, decision.requiredCallerScope!);
    if (!deps.canWriteToScope(acl)) {
      return reply.status(403).send({
        error: 'Forbidden',
        detail: `Promotion to ${decision.targetScope} requires ${decision.requiredCallerScope} caller scope, you have ${acl.requesterScope}`,
      });
    }

    // Apply promotion: update metadata.scope
    const updatedMetadata = {
      ...(obs.metadata as Record<string, unknown>),
      scope: decision.targetScope,
      promotedAt: new Date().toISOString(),
      promotedFrom: fromScope,
      promotedGate: decision.gate,
    };

    await deps.updateObservation(parseInt(id), { metadata: updatedMetadata });
    const updated = await deps.getObservation(parseInt(id));

    return {
      ok: true,
      fromScope,
      toScope: decision.targetScope,
      gate: decision.gate,
      observation: updated,
    };
  });
}
