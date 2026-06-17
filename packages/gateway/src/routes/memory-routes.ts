import type { FastifyInstance } from 'fastify';
import {
  ensureMemoryStore, addObservation, searchObservations,
  getStats, deleteObservation, updateObservation,
  ensureMemoryCompactionStore, compactSession, listCompactions,
  retrieveActiveRules, routeMemoryRetrieval,
  applyRetentionPolicy, checkMemoryIntegrity,
  getLatestCheckpoint,
} from '@los/memory';
import { syncMemoryMd } from '@los/memory';
import { ensureRunEvalStore } from '@los/agent';
import { ensureTaskRunStore } from '@los/agent/task-runs';
import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import { getRequestContext } from '../request-context.js';
import {
  normalizeOptionalString,
  normalizeStringArray,
  normalizeMemoryMetadata,
  parseOptionalBoolean,
  normalizeBoundedInteger,
} from './server-helpers.js';

const log = getLogger('memory-routes');

export function registerMemoryRoutes(app: FastifyInstance): void {
  app.get('/memory', async (req) => {
    const query = req.query as {
      q?: string; kind?: string; source?: string; tag?: string; scope?: string;
      memoryLayer?: string; archived?: string; sessionId?: string;
      tenantId?: string; projectId?: string; userId?: string;
      requestId?: string; traceId?: string; limit?: string;
    };
    await ensureMemoryStore();
    const results = await searchObservations(query.q ?? '', {
      kind: query.kind,
      source: query.source,
      tag: query.tag,
      scope: query.scope,
      memoryLayer: query.memoryLayer,
      archived: parseOptionalBoolean(query.archived),
      sessionId: query.sessionId,
      tenantId: query.tenantId,
      projectId: query.projectId,
      userId: query.userId,
      requestId: query.requestId,
      traceId: query.traceId,
      limit: normalizeBoundedInteger(query.limit, 20, 1, 200),
    });
    return { count: results.length, results };
  });

  app.post('/memory', async (req) => {
    const { title, summary, kind, tags, content, metadata, source, sessionId, nodeId } = req.body as any;
    const context = getRequestContext(req);
    await ensureMemoryStore();
    const obs = await addObservation({
      title, summary, kind,
      tags: normalizeStringArray(tags),
      content,
      source,
      metadata: normalizeMemoryMetadata(metadata, { scope: 'project', memoryLayer: 'semantic', archived: false }),
      sessionId: normalizeOptionalString(sessionId),
      tenantId: context.tenantId,
      projectId: context.projectId,
      userId: context.userId,
      nodeId: normalizeOptionalString(nodeId),
      requestId: context.requestId,
      traceId: context.traceId,
    });
    return obs;
  });

  app.patch('/memory/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as any;
    await ensureMemoryStore();
    const obs = await updateObservation(parseInt(id), {
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

  app.delete('/memory/:id', async (req) => {
    const { id } = req.params as { id: string };
    await ensureMemoryStore();
    const ok = await deleteObservation(parseInt(id));
    return { ok };
  });

  app.get('/memory/stats', async () => {
    await ensureMemoryStore();
    return await getStats();
  });

  app.post('/memory/compact', async (req, reply) => {
    const body = req.body as { sessionId?: string; runSpecId?: string };
    const sessionId = normalizeOptionalString(body.sessionId);
    if (!sessionId) return reply.status(422).send({ error: 'sessionId is required' });
    const context = getRequestContext(req);
    await ensureMemoryCompactionStore();
    await ensureRunEvalStore();
    await ensureTaskRunStore();
    const compaction = await compactSession({
      sessionId,
      runSpecId: normalizeOptionalString(body.runSpecId),
      tenantId: context.tenantId,
      projectId: context.projectId,
      createdBy: context.userId ?? context.requestId,
    });
    return { compaction };
  });

  app.get('/memory/compactions', async (req) => {
    const query = req.query as { sessionId?: string; runSpecId?: string; limit?: string };
    const context = getRequestContext(req);
    await ensureMemoryCompactionStore();
    const compactions = await listCompactions({
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
    const checkpoint = await getLatestCheckpoint(sessionId);
    return { checkpoint };
  });

  app.get('/memory/active-rules', async (req) => {
    const query = req.query as { runSpecId?: string; limit?: string };
    const context = getRequestContext(req);
    await ensureMemoryCompactionStore();
    const rules = await retrieveActiveRules({
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
    await ensureMemoryStore();
    await ensureMemoryCompactionStore();
    const result = await routeMemoryRetrieval({
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
    await ensureMemoryStore();
    const observations = await searchObservations('', {
      limit: 50,
      scope: body.scope,
      memoryLayer: body.memoryLayer,
      archived: body.archived,
      projectId: body.projectId,
    });
    syncMemoryMd(body.workspaceRoot, observations);
    return { ok: true, count: observations.length };
  });

  app.post('/memory/retention', async (req) => {
    const body = req.body as { dryRun?: boolean };
    if (body.dryRun) {
      // For dry-run, just report what would happen without applying
      const stats = await getStats();
      return { dryRun: true, totalObservations: stats.totalObservations, archived: stats.archived };
    }
    const result = await applyRetentionPolicy();
    return { ok: true, ...result };
  });

  app.get('/memory/integrity', async () => {
    const report = await checkMemoryIntegrity();
    return report;
  });

  // Auto-compact: find uncompacted sessions (>1h old) and compact them.
  // Called by the scheduler or governance sweeper periodically.
  app.post('/memory/auto-compact', async () => {
    await ensureMemoryStore();
    await ensureMemoryCompactionStore();
    await ensureRunEvalStore();
    await ensureTaskRunStore();

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
        const result = await compactSession({ sessionId });
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
}
