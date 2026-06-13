import type { SessionEventRecord } from '@los/agent/session-events';
import { buildToolCallUpsertFromSessionEvent, createRunningToolCallUpsert } from './tool-call-upsert.js';
import { persistStreamCheckpoint } from './chat-stream-persist.js';

export type SendEvent = (event: string, data: unknown, id?: number) => void;

export async function emitRunningToolCallUpsert(args: {
  send: SendEvent;
  sessionId: string;
  runSpecId: string;
  turn: number;
  callId: string;
  toolName: string;
  input: Record<string, unknown>;
}): Promise<void> {
  const payload = createRunningToolCallUpsert(args.callId, args.toolName, args.input);
  args.send('tool.call.upsert', payload);
  await persistStreamCheckpoint({
    sessionId: args.sessionId,
    runSpecId: args.runSpecId,
    turn: args.turn,
    eventType: 'tool.call.upsert',
    payload,
  });
}

export function relaySessionEvent(send: SendEvent, event: SessionEventRecord): void {
  send(event.type, {
    id: event.id,
    sessionId: event.sessionId,
    tenantId: event.tenantId ?? null,
    projectId: event.projectId ?? null,
    userId: event.userId ?? null,
    nodeId: event.nodeId ?? null,
    requestId: event.requestId ?? null,
    traceId: event.traceId ?? null,
    turn: event.turn,
    source: event.source,
    model: event.model ?? null,
    toolName: event.toolName ?? null,
    cacheKey: event.cacheKey ?? null,
    cacheHit: event.cacheHit ?? null,
    usage: event.usage ?? null,
    payload: event.payload,
    createdAt: event.createdAt,
  }, event.id);
}

export async function emitToolCallUpsertFromSessionEvent(args: {
  send: SendEvent;
  sessionId: string;
  runSpecId: string;
  event: SessionEventRecord;
}): Promise<void> {
  const payload = buildToolCallUpsertFromSessionEvent(args.event);
  if (!payload) return;
  args.send('tool.call.upsert', payload);
  await persistStreamCheckpoint({
    sessionId: args.sessionId,
    runSpecId: args.runSpecId,
    turn: args.event.turn,
    eventType: 'tool.call.upsert',
    payload,
  });
}
