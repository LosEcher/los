import { getLogger } from '@los/infra/logger';
import {
  appendSessionEvent,
  ensureSessionEventStore,
  type SessionEventRecord,
  type SessionEventWrite,
} from './session-events.js';

const log = getLogger('agent');

export interface SessionEventContext {
  tenantId?: string;
  projectId?: string;
  userId?: string;
  nodeId?: string;
  requestId?: string;
  traceId?: string;
}

export type SessionEventCallback = (event: SessionEventRecord) => void | Promise<void>;

export function createEventEmitter(
  sessionId: string | undefined,
  context: SessionEventContext,
  onSessionEvent: SessionEventCallback | undefined,
  options: { persist?: boolean } = {},
) {
  return async (event: Omit<SessionEventWrite, 'sessionId'>): Promise<SessionEventRecord | null> => {
    if (!sessionId) return null;
    if (options.persist === false) {
      const record: SessionEventRecord = {
        id: 0,
        sessionId,
        tenantId: context.tenantId,
        projectId: context.projectId,
        userId: context.userId,
        nodeId: context.nodeId,
        requestId: context.requestId,
        traceId: context.traceId,
        turn: event.turn ?? 0,
        type: event.type,
        source: event.source ?? 'los',
        model: event.model,
        toolName: event.toolName,
        cacheKey: event.cacheKey,
        cacheHit: event.cacheHit,
        usage: {
          promptTokens: event.usage?.promptTokens ?? 0,
          completionTokens: event.usage?.completionTokens ?? 0,
          cacheHitTokens: event.usage?.cacheHitTokens ?? 0,
          cacheMissTokens: event.usage?.cacheMissTokens ?? 0,
          totalTokens: event.usage?.totalTokens ?? 0,
        },
        parentEventId: event.parentEventId,
        payload: event.payload ?? {},
        visibility: event.visibility ?? 'public',
        createdAt: new Date().toISOString(),
      };
      try {
        await onSessionEvent?.(record);
      } catch (err: any) {
        log.warn(`Session event callback failed: ${err.message ?? String(err)}`);
      }
      return record;
    }
    try {
      await ensureSessionEventStore();
      const written = await appendSessionEvent({
        sessionId,
        tenantId: context.tenantId,
        projectId: context.projectId,
        userId: context.userId,
        nodeId: context.nodeId,
        requestId: context.requestId,
        traceId: context.traceId,
        ...event,
      });
      try {
        await onSessionEvent?.(written);
      } catch (err: any) {
        log.warn(`Session event callback failed: ${err.message ?? String(err)}`);
      }
      return written;
    } catch (err: any) {
      log.warn(`Session event write failed: ${err.message ?? String(err)}`);
      return null;
    }
  };
}
