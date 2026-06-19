import type { FastifyInstance } from 'fastify';
import { ensureSessionStore, loadSession } from '@los/agent/session';
import { ensureSessionEventStore, listSessionEvents, listSessionEventsSince } from '@los/agent/session-events';
import { projectSessionTrace, type TraceToolCallCard, type TraceTurnProjection } from '@los/agent/session-trace';
import type { Message, TurnSummary } from '@los/agent';
import { asObject, truncate } from '../../trace-utils.js';

type TraceMessageRole = 'user' | 'assistant' | 'system' | 'separator';

type TraceToolCallStatus = 'running' | 'completed' | 'error' | 'denied';

type TraceToolCall = {
  callId: string;
  toolName: string;
  status: TraceToolCallStatus;
  argsPreview: string;
  args?: Record<string, unknown>;
  resultPreview?: string;
  errorPreview?: string;
  durationMs?: number;
  attempts?: number;
};

type TraceMessage = {
  role: TraceMessageRole;
  content: string;
  meta?: string;
  level?: 'normal' | 'ok' | 'warn' | 'error';
  eventType?: string;
  provider?: string;
  model?: string;
  turnIndex?: number;
  totalTurns?: number;
  reasoning?: string;
  toolCalls: TraceToolCall[];
};

function normalizeToolStatus(card: TraceToolCallCard): TraceToolCallStatus {
  if (card.status === 'denied') return 'denied';
  if (card.status === 'completed') return 'completed';
  if (card.status === 'error') return 'error';
  return 'running';
}

function toolCallFromCard(card: TraceToolCallCard): TraceToolCall {
  return {
    callId: card.callId,
    toolName: card.toolName,
    status: normalizeToolStatus(card),
    argsPreview: card.argsPreview,
    args: card.args,
    resultPreview: card.resultPreview,
    errorPreview: card.errorPreview,
    durationMs: card.durationMs,
    attempts: card.attempts,
  };
}

function toolCallsForAssistantMessage(args: {
  assistantMsg: Message;
  turn: TraceTurnProjection | undefined;
}): TraceToolCall[] {
  const fromTurn = args.turn?.toolCalls ?? [];
  const byCallId = new Map(fromTurn.map(card => [card.callId, card]));

  const toolCalls = Array.isArray((args.assistantMsg as any).tool_calls)
    ? ((args.assistantMsg as any).tool_calls as Array<Record<string, unknown>>)
    : [];

  const ordered: TraceToolCall[] = [];
  for (const tc of toolCalls) {
    const callId = typeof tc.id === 'string' ? tc.id : '';
    const existing = callId ? byCallId.get(callId) : undefined;
    if (existing) {
      ordered.push(toolCallFromCard(existing));
      byCallId.delete(existing.callId);
      continue;
    }
    const fn = tc.function as Record<string, unknown> | undefined;
    const toolName = typeof fn?.name === 'string' ? fn.name : '';
    const rawArgs = typeof fn?.arguments === 'string' ? fn.arguments : '';
    ordered.push({
      callId: callId || crypto.randomUUID(),
      toolName,
      status: 'completed',
      argsPreview: truncate(rawArgs, 200),
    });
  }

  for (const remaining of byCallId.values()) {
    ordered.push(toolCallFromCard(remaining));
  }

  return ordered;
}

function buildTraceMessages(args: {
  apiMessages: Message[];
  turns: TurnSummary[];
  traceTurns: TraceTurnProjection[];
}): TraceMessage[] {
  const traceTurnMap = new Map<number, TraceTurnProjection>();
  for (const t of args.traceTurns) traceTurnMap.set(t.turn, t);

  const result: TraceMessage[] = [];
  let turnIdx = 0;

  for (const msg of args.apiMessages) {
    const role = String((msg as any).role ?? '');
    if (role === 'system' || role === 'developer') continue;

    if (role === 'user') {
      result.push({
        role: 'user',
        content: String((msg as any).content ?? ''),
        toolCalls: [],
      });
      continue;
    }

    if (role === 'assistant') {
      const turnNumber = turnIdx + 1;
      const traceTurn = traceTurnMap.get(turnNumber);
      const turn = args.turns[turnIdx];
      const reasoning = (turn as any)?.reasoningContent && typeof (turn as any).reasoningContent === 'string'
        ? String((turn as any).reasoningContent)
        : undefined;
      const provider = traceTurn?.provider;
      const model = traceTurn?.model;
      result.push({
        role: 'assistant',
        content: String((msg as any).content ?? ''),
        reasoning,
        provider,
        model,
        turnIndex: turnNumber,
        totalTurns: args.turns.length,
        toolCalls: toolCallsForAssistantMessage({ assistantMsg: msg, turn: traceTurn }),
      });
      turnIdx += 1;
    }
  }

  return result;
}

function buildTraceMessagesFromEvents(args: {
  session: unknown;
  events: Array<{ type: string; turn: number; model?: string | null; payload: unknown }>;
  traceTurns: TraceTurnProjection[];
}): TraceMessage[] {
  const result: TraceMessage[] = [];
  const prompt = asObject((args.session as any)?.metadata)?.prompt;
  if (typeof prompt === 'string' && prompt.trim()) {
    result.push({ role: 'user', content: truncate(prompt.trim(), 4000), toolCalls: [] });
  }

  const responseByTurn = new Map<number, Record<string, unknown>>();
  for (const event of args.events) {
    if (event.type !== 'model.response') continue;
    const payload = asObject(event.payload);
    if (!payload) continue;
    responseByTurn.set(event.turn, payload);
  }

  const maxTurn = args.traceTurns.reduce((max, t) => Math.max(max, t.turn), 0);
  const totalTurns = maxTurn > 0 ? maxTurn : undefined;
  for (const [idx, turn] of args.traceTurns.entries()) {
    const payload = responseByTurn.get(turn.turn);
    const textPreview = typeof payload?.textPreview === 'string' ? payload.textPreview : '';
    const reasoning = typeof payload?.reasoningPreview === 'string' ? payload.reasoningPreview : undefined;
    const provider = typeof payload?.provider === 'string' ? payload.provider : turn.provider;
    const model = turn.model ?? (typeof payload?.model === 'string' ? payload.model : undefined);
    result.push({
      role: 'assistant',
      content: textPreview,
      reasoning,
      provider,
      model,
      turnIndex: turn.turn,
      totalTurns,
      toolCalls: turn.toolCalls.map(toolCallFromCard),
    });
  }

  return result;
}

export function registerTraceRoutes(app: FastifyInstance): void {
  app.get('/sessions/:id/trace', async (req, reply) => {
    const { id } = req.params as { id: string };

    await ensureSessionStore();
    await ensureSessionEventStore();

    const session = await loadSession(id);
    if (!session) return reply.status(404).send({ error: 'Not found' });

    const events = await listSessionEvents(id, 10000);
    const projection = projectSessionTrace(id, events);

    const apiMessages = session.messages;
    const turns = session.turns;

    const messages =
      apiMessages.length > 0
        ? buildTraceMessages({
            apiMessages,
            turns,
            traceTurns: projection.turns,
          })
        : buildTraceMessagesFromEvents({
            session,
            events,
            traceTurns: projection.turns,
          });

    const maxProjectedTurn = projection.turns.reduce((max, t) => Math.max(max, t.turn), 0);
    const fallbackTurnCount = maxProjectedTurn > 0 ? maxProjectedTurn : projection.turns.length;

    return {
      sessionId: id,
      messageCount: messages.length,
      turnCount: apiMessages.length > 0 ? turns.length : fallbackTurnCount,
      messages,
    };
  });

  // Incremental trace endpoint for live update polling
  app.get('/sessions/:id/trace/since', async (req, reply) => {
    const { id } = req.params as { id: string };
    const since = Math.max(0, Number((req.query as { since?: string }).since ?? 0));

    await ensureSessionStore();
    await ensureSessionEventStore();

    const session = await loadSession(id);
    if (!session) return reply.status(404).send({ error: 'Not found' });

    if (since > 0) {
      const newEvents = await listSessionEventsSince(id, since, 10000);
      if (newEvents.length === 0) {
        return { sessionId: id, since, nextSince: since, messages: [], unchanged: true };
      }
      const projection = projectSessionTrace(id, newEvents);
      const messages =
        session.messages.length > 0
          ? buildTraceMessages({ apiMessages: session.messages, turns: session.turns, traceTurns: projection.turns })
          : buildTraceMessagesFromEvents({ session, events: newEvents, traceTurns: projection.turns });
      const nextSince = newEvents.reduce((max, e) => Math.max(max, e.id), since);
      return { sessionId: id, since, nextSince, messages };
    }

    // since=0: full trace, same as /trace
    const events = await listSessionEvents(id, 10000);
    const projection = projectSessionTrace(id, events);
    const apiMessages = session.messages;
    const turns = session.turns;
    const messages =
      apiMessages.length > 0
        ? buildTraceMessages({ apiMessages, turns, traceTurns: projection.turns })
        : buildTraceMessagesFromEvents({ session, events, traceTurns: projection.turns });
    const maxProjectedTurn = projection.turns.reduce((max, t) => Math.max(max, t.turn), 0);
    const fallbackTurnCount = maxProjectedTurn > 0 ? maxProjectedTurn : projection.turns.length;
    const nextSince = events.length > 0 ? events[events.length - 1].id : 0;
    return {
      sessionId: id,
      messageCount: messages.length,
      turnCount: apiMessages.length > 0 ? turns.length : fallbackTurnCount,
      messages,
      since: 0,
      nextSince,
    };
  });
}
