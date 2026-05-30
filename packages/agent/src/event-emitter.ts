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
) {
  return async (event: Omit<SessionEventWrite, 'sessionId'>): Promise<SessionEventRecord | null> => {
    if (!sessionId) return null;
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
