import type { SessionEventRecord } from './session-events.js';

export type TraceToolCallStatus = 'running' | 'completed' | 'error' | 'denied';

export type TraceToolCallCard = {
  callId: string;
  toolName: string;
  turn: number;
  status: TraceToolCallStatus;
  argsPreview: string;
  args?: Record<string, unknown>;
  resultPreview?: string;
  errorPreview?: string;
  durationMs?: number;
  attempts?: number;
};

export type TraceTurnProjection = {
  turn: number;
  provider?: string;
  model?: string;
  durationMs?: number;
  usage?: SessionEventRecord['usage'];
  toolCalls: TraceToolCallCard[];
};

export type SessionTraceProjection = {
  sessionId: string;
  turns: TraceTurnProjection[];
};

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
}

function previewArgs(args: unknown): string {
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') return truncate(args, 200);
  const obj = asObject(args);
  if (!obj) return truncate(String(args), 200);
  try {
    return truncate(JSON.stringify(obj), 200);
  } catch {
    return truncate(String(args), 200);
  }
}

function resolveCallId(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  const callId = payload.callId;
  return typeof callId === 'string' && callId ? callId : null;
}

function resolveToolName(event: { toolName?: string | null; payload: unknown }): string {
  if (event.toolName) return event.toolName;
  const p = asObject(event.payload);
  return typeof p?.toolName === 'string' ? p.toolName : '';
}

type ToolCardState = TraceToolCallCard;

export function projectSessionTrace(sessionId: string, events: SessionEventRecord[]): SessionTraceProjection {
  const toolByCallId = new Map<string, ToolCardState>();
  const toolsByTurn = new Map<number, string[]>();
  const turnMeta = new Map<number, Omit<TraceTurnProjection, 'turn' | 'toolCalls'>>();
  let sessionCompleted = false;

  for (const event of events) {
    const payload = asObject(event.payload);

    if (event.type === 'session.completed') {
      sessionCompleted = true;
      continue;
    }

    if (event.type === 'model.response') {
      const durationMs = typeof payload?.durationMs === 'number' ? payload.durationMs : undefined;
      const provider = typeof payload?.provider === 'string' ? payload.provider : undefined;
      turnMeta.set(event.turn, {
        provider,
        model: event.model ?? undefined,
        durationMs,
        usage: event.usage,
      });
      continue;
    }

    if (event.type.startsWith('tool.')) {
      // tool.repair — argument repair events emitted during provider delta repair
      if (event.type === 'tool.repair') {
        const callId = resolveCallId(payload);
        if (callId) {
          const existing = toolByCallId.get(callId);
          if (existing) {
            existing.status = 'running';
          }
        }
        continue;
      }

      const callId = resolveCallId(payload);
      if (!callId) continue;

      const toolName = resolveToolName(event);
      const existing = toolByCallId.get(callId);

      const state: ToolCardState = existing ?? {
        callId,
        toolName,
        turn: event.turn,
        status: 'running',
        argsPreview: '',
      };

      if (!existing) {
        const list = toolsByTurn.get(event.turn) ?? [];
        list.push(callId);
        toolsByTurn.set(event.turn, list);
      }

      if (event.type === 'tool.call') {
        const args = payload?.args;
        state.args = asObject(args) ?? undefined;
        state.argsPreview = previewArgs(args);
      }

      if (event.type === 'tool.denied') {
        state.status = 'denied';
        state.errorPreview = typeof payload?.reason === 'string' ? truncate(payload.reason, 200) : state.errorPreview;
      }

      if (event.type === 'tool.result') {
        const ok = payload?.ok === true;
        const denied = payload?.denied === true;
        state.status = denied ? 'denied' : ok ? 'completed' : 'error';
        state.durationMs = typeof payload?.durationMs === 'number' ? payload.durationMs : state.durationMs;
        state.attempts = typeof payload?.attempts === 'number' ? payload.attempts : state.attempts;
        state.resultPreview = typeof payload?.contentPreview === 'string' ? payload.contentPreview : state.resultPreview;
        state.errorPreview = typeof payload?.errorPreview === 'string' ? payload.errorPreview : state.errorPreview;
      }

      if (event.type === 'tool.approved') {
        if (state.status === 'denied') {
          // keep denied
        } else if (state.status !== 'completed' && state.status !== 'error') {
          state.status = 'running';
        }
      }

      if (event.type === 'tool.planned' && state.argsPreview === '') {
        const args = payload?.args;
        state.args = asObject(args) ?? state.args;
        state.argsPreview = previewArgs(args);
      }

      toolByCallId.set(callId, state);
      continue;
    }
  }

  // Invariant: if session completed, any tool call still 'running' -> 'error'
  if (sessionCompleted) {
    for (const [callId, card] of toolByCallId) {
      if (card.status === 'running') {
        toolByCallId.set(callId, {
          ...card,
          status: 'error',
          errorPreview: 'Session completed before tool call finished',
        });
      }
    }
  }

  const turns: TraceTurnProjection[] = [];
  const allTurns = new Set<number>();
  for (const event of events) {
    if (event.turn > 0) allTurns.add(event.turn);
  }
  for (const turn of [...allTurns].sort((a, b) => a - b)) {
    const callIds = toolsByTurn.get(turn) ?? [];
    const toolCalls = callIds
      .map(id => toolByCallId.get(id))
      .filter(Boolean) as TraceToolCallCard[];
    const meta = turnMeta.get(turn) ?? {};
    turns.push({
      turn,
      provider: meta.provider,
      model: meta.model,
      durationMs: meta.durationMs,
      usage: meta.usage,
      toolCalls,
    });
  }

  return { sessionId, turns };
}

export function validateTraceCompleteness(
  events: SessionEventRecord[],
  projection: SessionTraceProjection,
): { orphans: string[]; stalledRunning: string[] } {
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();
  const deniedIds = new Set<string>();

  for (const event of events) {
    const payload = asObject(event.payload);
    if (event.type === 'tool.call') {
      const callId = resolveCallId(payload);
      if (callId) toolCallIds.add(callId);
    }
    if (event.type === 'tool.result') {
      const callId = resolveCallId(payload);
      if (callId) toolResultIds.add(callId);
    }
    if (event.type === 'tool.denied') {
      const callId = resolveCallId(payload);
      if (callId) deniedIds.add(callId);
    }
  }

  const orphanCalls = [...toolCallIds].filter(id => !toolResultIds.has(id) && !deniedIds.has(id));

  const stalledRunning: string[] = [];
  for (const turn of projection.turns) {
    for (const tc of turn.toolCalls) {
      if (tc.status === 'running') {
        stalledRunning.push(tc.callId);
      }
    }
  }

  return { orphans: orphanCalls, stalledRunning };
}
