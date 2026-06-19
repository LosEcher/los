import type { FastifyInstance } from 'fastify';
import {
  ensureSessionEventStore,
  listSessionEvents,
  getSessionObservability,
} from '@los/agent/session-events';
import {
  recordOperatorFollowup,
  recordOperatorSteering,
} from '@los/agent/operator-control';
import { ensureSessionStore, loadSession, listSessions, saveSession, deleteSession, type SessionRecord } from '@los/agent/session';
import { claimRunSpec } from '@los/agent/run-specs';
import { listVerificationRecordsForSession } from '@los/agent';
import { findRecoverableSessions } from '../../chat-session-helpers.js';
import { getRequestContext } from '../../request-context.js';
import { getConfig } from '@los/infra/config';
import { resolveGatewayServiceIdentity } from '../../server.js';
import { normalizeBoundedInteger } from '../server-helpers.js';

export function registerSessionRoutes(app: FastifyInstance): void {
  app.get('/sessions', async () => {
    await ensureSessionStore();
    return await listSessions();
  });

  app.get('/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    await ensureSessionStore();
    const session = await loadSession(id);
    if (!session) return { error: 'Not found' };
    return session;
  });

  app.post('/sessions/:id/operator-events', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = normalizeOperatorEventBody(req.body);
    if (!body) {
      return reply.status(400).send({ error: 'type must be steering or followup' });
    }

    await ensureSessionStore();
    const session = await loadSession(id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });

    const context = getRequestContext(req);
    const common = {
      sessionId: id,
      runSpecId: body.runSpecId,
      taskRunId: body.taskRunId,
      tenantId: context.tenantId,
      projectId: context.projectId,
      userId: context.userId,
      requestId: context.requestId,
      traceId: context.traceId,
      actor: body.actor ?? context.userId,
      reason: body.reason,
    };

    try {
      const event = body.type === 'steering'
        ? await recordOperatorSteering({
            ...common,
            instruction: body.instruction,
            turnBoundary: body.turnBoundary,
            drainMode: body.drainMode,
          })
        : await recordOperatorFollowup({
            ...common,
            prompt: body.prompt,
            parentSessionId: body.parentSessionId,
          });
      return { ok: true, event };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: message });
    }
  });

  app.delete('/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await ensureSessionStore();
    const deleted = await deleteSession(id);
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

    await ensureSessionStore();
    const existing = await loadSession(body.id);
    if (existing) {
      return reply.status(409).send({ error: 'session already exists', id: body.id });
    }

    await saveSession({
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
    const claimed = await claimRunSpec(id, gatewayId);
    if (!claimed) return reply.status(404).send({ error: 'Run spec not found' });
    return { ok: true, runSpec: claimed, claimedBy: gatewayId };
  });

  app.get('/sessions/:id/events', async (req) => {
    const { id } = req.params as { id: string };
    const rawLimit = Number((req.query as { limit?: string }).limit ?? 200);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 && rawLimit <= 10000 ? rawLimit : 200;
    await ensureSessionEventStore();
    const events = await listSessionEvents(id, limit);
    return { sessionId: id, count: events.length, events };
  });

  app.get('/sessions/:id/observability', async (req) => {
    const { id } = req.params as { id: string };
    await ensureSessionEventStore();
    return await getSessionObservability(id);
  });

  app.get('/sessions/:id/verification', async (req) => {
    const { id } = req.params as { id: string };
    const records = await listVerificationRecordsForSession(id);
    return { sessionId: id, count: records.length, records };
  });
}

type OperatorEventBody =
  | {
      type: 'steering';
      instruction: string;
      runSpecId?: string;
      taskRunId?: string;
      actor?: string;
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
      actor?: string;
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
      actor: normalizeOptionalString(body.actor),
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
      actor: normalizeOptionalString(body.actor),
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
