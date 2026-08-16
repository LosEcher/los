import type { FastifyInstance } from 'fastify';
import {
  ensureSessionEventStore,
  latestEffectiveModels,
  listSessionEvents,
  listSessionEventsBefore,
  listSessionEventsSince,
  getSessionObservability,
  notifySessionEvent,
  type SessionEventRecord,
} from '@los/agent/session-events';
import {
  recordOperatorFollowup,
  recordOperatorSteering,
} from '@los/agent/operator-control';
import { ensureSessionStore, loadSession, listSessions, saveSession, deleteSession, type SessionRecord } from '@los/agent/session';
import { claimRunSpec } from '@los/agent/run-specs';
import { getSessionSubagents } from '@los/agent/session-subagents';
import { listVerificationRecordsForSession } from '@los/agent';
import { findRecoverableSessions } from '../../chat-session-helpers.js';
import { getOperatorPrincipal, getRequestContext, requireOperator } from '../../request-context.js';
import { runIdempotentJson } from '../../idempotency.js';
import { getConfig } from '@los/infra/config';
import { resolveGatewayServiceIdentity } from '../../server.js';
import { normalizeBoundedInteger } from '../server-helpers.js';

type SessionRouteDependencies = {
  claimRunSpec: typeof claimRunSpec;
  deleteSession: typeof deleteSession;
  getSessionObservability: typeof getSessionObservability;
  latestEffectiveModels: typeof latestEffectiveModels;
  listSessionEvents: typeof listSessionEvents;
  listSessionEventsBefore: typeof listSessionEventsBefore;
  listSessionEventsSince: typeof listSessionEventsSince;
  listSessions: typeof listSessions;
  listVerificationRecordsForSession: typeof listVerificationRecordsForSession;
  loadSession: typeof loadSession;
  notifySessionEvent: typeof notifySessionEvent;
  recordOperatorFollowup: typeof recordOperatorFollowup;
  recordOperatorSteering: typeof recordOperatorSteering;
  saveSession: typeof saveSession;
  ensureSessionStore: typeof ensureSessionStore;
  ensureSessionEventStore: typeof ensureSessionEventStore;
  getSessionSubagents: typeof getSessionSubagents;
};

const defaultDependencies: SessionRouteDependencies = {
  claimRunSpec,
  deleteSession,
  getSessionObservability,
  latestEffectiveModels,
  listSessionEvents,
  listSessionEventsBefore,
  listSessionEventsSince,
  listSessions,
  listVerificationRecordsForSession,
  loadSession,
  notifySessionEvent,
  recordOperatorFollowup,
  recordOperatorSteering,
  saveSession,
  ensureSessionStore,
  ensureSessionEventStore,
  getSessionSubagents,
};

export function registerSessionRoutes(
  app: FastifyInstance,
  deps: SessionRouteDependencies = defaultDependencies,
): void {
  app.get('/sessions', async () => {
    await deps.ensureSessionStore();
    const sessions = await deps.listSessions();
    // Effective-model projection: metadata.model is the REQUESTED model (null
    // when unspecified); the event ledger holds the model each model.response
    // actually ran on. UIs show requested ?? effective.
    const effective = await deps.latestEffectiveModels(sessions.map(session => session.id));
    return sessions.map(session => ({
      ...session,
      effectiveModel: effective.get(session.id) ?? null,
    }));
  });

  /** Cross-session event search (operator recall / FTS-lite). */
  app.get('/sessions/search', async (req) => {
    const query = req.query as {
      q?: string;
      sessionId?: string;
      limit?: string;
      includeInternal?: string;
    };
    const q = typeof query.q === 'string' ? query.q.trim() : '';
    if (!q) return { count: 0, results: [], error: 'q is required' };
    const { searchSessionEvents } = await import('@los/agent/session-events-search');
    const ctx = getRequestContext(req);
    const results = await searchSessionEvents({
      query: q,
      sessionId: typeof query.sessionId === 'string' ? query.sessionId : undefined,
      tenantId: ctx.isOperator ? undefined : ctx.tenantId,
      projectId: ctx.isOperator ? undefined : ctx.projectId,
      limit: Math.min(Math.max(Number(query.limit) || 20, 1), 100),
      includeInternal: query.includeInternal === 'true' && ctx.isOperator,
    });
    return {
      count: results.length,
      results: results.map(hit => ({
        sessionId: hit.sessionId,
        eventId: hit.event.id,
        type: hit.event.type,
        toolName: hit.event.toolName,
        rank: hit.rank,
        snippet: hit.snippet,
        createdAt: hit.event.createdAt,
        visibility: hit.event.visibility,
      })),
    };
  });

  app.get('/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    await deps.ensureSessionStore();
    const session = await deps.loadSession(id);
    if (!session) return { error: 'Not found' };
    const effective = await deps.latestEffectiveModels([id]);
    return { ...session, effectiveModel: effective.get(id) ?? null };
  });

  app.post('/sessions/:id/operator-events', async (req, reply) => {
    // Operator consent gate: steering + followup injection require operator
    // privilege (x-los-operator-token) when auth is enabled. Without this, any
    // authenticated user could inject approve/deny/escalate instructions.
    if (!(await requireOperator(req, reply))) return;
    const operator = getOperatorPrincipal(req);

    const { id } = req.params as { id: string };
    const body = normalizeOperatorEventBody(req.body);
    if (!body) {
      return reply.status(400).send({ error: 'type must be steering or followup' });
    }

    await deps.ensureSessionStore();
    const session = await deps.loadSession(id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });

    const context = getRequestContext(req);

    try {
      return await runIdempotentJson<{ ok: true; event: SessionEventRecord }>(req, reply, {
        route: '/sessions/:id/operator-events',
        method: 'POST',
        body,
        context,
        atomicEffect: true,
        afterCommit: async result => deps.notifySessionEvent(result.event),
      }, async transaction => {
        const writeOptions = { client: transaction?.client, notify: false };
        const common = {
          sessionId: id,
          runSpecId: body.runSpecId,
          taskRunId: body.taskRunId,
          tenantId: context.tenantId,
          projectId: context.projectId,
          userId: context.userId,
          requestId: context.requestId,
          traceId: context.traceId,
          actor: operator.subject,
          reason: body.reason,
        };
        const event = body.type === 'steering'
          ? await deps.recordOperatorSteering({
              ...common,
              instruction: body.instruction,
              turnBoundary: body.turnBoundary,
              drainMode: body.drainMode,
            }, writeOptions)
          : await deps.recordOperatorFollowup({
              ...common,
              prompt: body.prompt,
              parentSessionId: body.parentSessionId,
            }, writeOptions);
        return { ok: true, event };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: message });
    }
  });

  app.delete('/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await deps.ensureSessionStore();
    const deleted = await deps.deleteSession(id);
    if (!deleted) return reply.status(404).send({ error: 'Not found' });
    return { ok: true };
  });

  app.post('/sessions/import', async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body.id !== 'string' || !body.id) {
      return reply.status(400).send({ error: 'session id is required' });
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const turns = Array.isArray(body.turns) ? body.turns : [];
    const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? body.metadata as Record<string, unknown>
      : {};

    await deps.ensureSessionStore();
    const existing = await deps.loadSession(body.id);
    if (existing) {
      return reply.status(409).send({ error: 'session already exists', id: body.id });
    }

    await deps.saveSession({
      id: body.id,
      createdAt: typeof body.createdAt === 'string' ? body.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: messages as SessionRecord['messages'],
      turns: turns as SessionRecord['turns'],
      metadata: { ...metadata, imported: true, importedAt: new Date().toISOString() },
    });
    return { ok: true, id: body.id };
  });

  app.get('/sessions/recoverable', async (req) => {
    const query = req.query as { limit?: string };
    const limit = normalizeBoundedInteger(query.limit, 50, 1, 200);
    const sessions = await findRecoverableSessions({ limit });
    return {
      count: sessions.length,
      sessions,
      hint: 'Use POST /chat with sessionId to resume. GET /sessions/:id/events/stream replays missed events. POST /runs/:id/claim to take over an orphaned run.',
    };
  });

  app.post('/runs/:id/claim', async (req, reply) => {
    const { id } = req.params as { id: string };
    const gatewayId = (req.body as { gatewayId?: string }).gatewayId ?? resolveGatewayServiceIdentity(getConfig()).serviceId;
    const claimed = await deps.claimRunSpec(id, gatewayId);
    if (!claimed) return reply.status(404).send({ error: 'Run spec not found' });
    return { ok: true, runSpec: claimed, claimedBy: gatewayId };
  });

  /**
   * GET /sessions/:id/events — event ledger window.
   * Query:
   *   limit           page size (1..10000, default 200)
   *   includeInternal '1'|'true' to include internal rows (default hidden)
   *   since           event-id high-water cursor (exclusive); returns only
   *                   events with id > since, plus nextSince for the next poll.
   *                   Mirrors /trace/since cursor semantics for the raw ledger.
   *   before          event-id upper bound (exclusive); returns the window of
   *                   events with id < before in ascending order (oldest first)
   *                   for "load earlier" pagination.
   *   since and before are mutually exclusive; before wins when both present.
   */
  app.get('/sessions/:id/events', async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as { limit?: string; includeInternal?: string; since?: string; before?: string };
    const rawLimit = Number(query.limit ?? 200);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 && rawLimit <= 10000 ? rawLimit : 200;
    // Operator UI default: hide internal state-machine noise. Pass includeInternal=1 for full ledger.
    const includeInternal = query.includeInternal === '1' || query.includeInternal === 'true';
    const rawSince = Number(query.since ?? 0);
    const since = Number.isFinite(rawSince) && rawSince > 0 ? rawSince : 0;
    const rawBefore = Number(query.before ?? 0);
    const before = Number.isFinite(rawBefore) && rawBefore > 0 ? rawBefore : 0;
    await deps.ensureSessionEventStore();

    if (before > 0) {
      const events = await deps.listSessionEventsBefore(id, before, limit, { includeInternal });
      return {
        sessionId: id,
        count: events.length,
        events,
        includeInternal,
        before,
        hasMore: events.length === limit,
      };
    }

    if (since > 0) {
      const events = await deps.listSessionEventsSince(id, since, limit, { includeInternal });
      const nextSince = events.reduce((max, e) => Math.max(max, e.id), since);
      return {
        sessionId: id,
        count: events.length,
        events,
        includeInternal,
        since,
        nextSince,
        unchanged: events.length === 0,
      };
    }

    const events = await deps.listSessionEvents(id, limit, { includeInternal });
    const nextSince = events.length > 0 ? events[events.length - 1].id : 0;
    return { sessionId: id, count: events.length, events, includeInternal, since: 0, nextSince };
  });

  app.get('/sessions/:id/observability', async (req) => {
    const { id } = req.params as { id: string };
    await deps.ensureSessionEventStore();
    return await deps.getSessionObservability(id);
  });

  app.get('/sessions/:id/verification', async (req) => {
    const { id } = req.params as { id: string };
    const records = await deps.listVerificationRecordsForSession(id);
    return { sessionId: id, count: records.length, records };
  });

  /** Phase 4: recursive child-agent lineage for one session. */
  app.get('/sessions/:id/subagents', async (req, reply) => {
    const { id } = req.params as { id: string };
    const maxDepth = normalizeBoundedInteger((req.query as { maxDepth?: string }).maxDepth, 4, 1, 8);
    try {
      return await deps.getSessionSubagents(id, maxDepth);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: 'subagents_query_failed', message });
    }
  });
}

type OperatorEventBody =
  | {
      type: 'steering';
      instruction: string;
      runSpecId?: string;
      taskRunId?: string;
      reason?: string;
      turnBoundary?: 'next_turn' | 'immediate';
      drainMode?: 'none' | 'finish_current_tool' | 'finish_current_turn';
    }
  | {
      type: 'followup';
      prompt: string;
      parentSessionId?: string;
      runSpecId?: string;
      taskRunId?: string;
      reason?: string;
    };

function normalizeOperatorEventBody(value: unknown): OperatorEventBody | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const type = normalizeOptionalString(body.type);
  if (type === 'steering') {
    return {
      type,
      instruction: normalizeOptionalString(body.instruction) ?? normalizeOptionalString(body.prompt) ?? '',
      runSpecId: normalizeOptionalString(body.runSpecId),
      taskRunId: normalizeOptionalString(body.taskRunId),
      reason: normalizeOptionalString(body.reason),
      turnBoundary: normalizeTurnBoundary(body.turnBoundary),
      drainMode: normalizeDrainMode(body.drainMode),
    };
  }
  if (type === 'followup') {
    return {
      type,
      prompt: normalizeOptionalString(body.prompt) ?? normalizeOptionalString(body.instruction) ?? '',
      parentSessionId: normalizeOptionalString(body.parentSessionId),
      runSpecId: normalizeOptionalString(body.runSpecId),
      taskRunId: normalizeOptionalString(body.taskRunId),
      reason: normalizeOptionalString(body.reason),
    };
  }
  return null;
}

function normalizeTurnBoundary(value: unknown): 'next_turn' | 'immediate' | undefined {
  return value === 'next_turn' || value === 'immediate' ? value : undefined;
}

function normalizeDrainMode(value: unknown): 'none' | 'finish_current_tool' | 'finish_current_turn' | undefined {
  return value === 'none' || value === 'finish_current_tool' || value === 'finish_current_turn' ? value : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
