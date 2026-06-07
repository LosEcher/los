import type { FastifyInstance } from 'fastify';
import {
  ensureMemoryStore, addObservation, searchObservations,
  getStats, deleteObservation, updateObservation,
  ensureMemoryCompactionStore, compactSession, listCompactions,
} from '@los/memory';
import { syncMemoryMd } from '@los/memory';
import { ensureRunEvalStore } from '@los/agent';
import { ensureTaskRunStore } from '@los/agent/task-runs';
import { getRequestContext } from '../request-context.js';
import {
  normalizeOptionalString,
  normalizeStringArray,
  normalizeMemoryMetadata,
  parseOptionalBoolean,
  normalizeBoundedInteger,
} from './server-helpers.js';

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
      createdBy: context.userId ?? context.requestId,
    });
    return { compaction };
  });

  app.get('/memory/compactions', async (req) => {
    const query = req.query as { sessionId?: string; runSpecId?: string; limit?: string };
    await ensureMemoryCompactionStore();
    const compactions = await listCompactions({
      sessionId: normalizeOptionalString(query.sessionId),
      runSpecId: normalizeOptionalString(query.runSpecId),
      limit: normalizeBoundedInteger(query.limit, 100, 1, 1000),
    });
    return { count: compactions.length, compactions };
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
}
