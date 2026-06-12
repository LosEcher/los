import type { SessionEventRecord } from '@los/agent/session-events';

export type ToolCallUpsertPayload = {
  callId: string;
  toolName: string;
  status: 'running' | 'completed' | 'error' | 'denied';
  argsPreview?: string;
  resultPreview?: string;
  errorPreview?: string;
  durationMs?: number;
  attempts?: number;
};

export function createRunningToolCallUpsert(
  callId: string,
  toolName: string,
  args: Record<string, unknown>,
): ToolCallUpsertPayload {
  let argsPreview = '';
  try {
    argsPreview = JSON.stringify(args).slice(0, 200);
  } catch {
    argsPreview = '';
  }
  return {
    callId,
    toolName,
    status: 'running',
    argsPreview,
  };
}

export function buildToolCallUpsertFromSessionEvent(
  event: SessionEventRecord,
): ToolCallUpsertPayload | null {
  if (event.type !== 'tool.result') return null;
  const payload = event.payload;
  const callId = typeof payload.callId === 'string' ? payload.callId : '';
  const toolName = event.toolName ?? (typeof payload.toolName === 'string' ? payload.toolName : '');
  if (!callId || !toolName) return null;
  const denied = payload.denied === true;
  const ok = payload.ok === true;
  return {
    callId,
    toolName,
    status: denied ? 'denied' : ok ? 'completed' : 'error',
    resultPreview: typeof payload.contentPreview === 'string' ? payload.contentPreview : undefined,
    errorPreview: typeof payload.errorPreview === 'string' ? payload.errorPreview : undefined,
    durationMs: typeof payload.durationMs === 'number' ? payload.durationMs : undefined,
    attempts: typeof payload.attempts === 'number' ? payload.attempts : undefined,
  };
}
