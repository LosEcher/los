/**
 * Live tool call tracking hook.
 * Processes tool.call.upsert events from the SSE/WS stream to update
 * tool call status in real time without waiting for trace polls.
 */
import { useRef, useState, useCallback } from 'react';
import type { ToolCall } from '../chat-messages.js';

export function useLiveToolCalls() {
  const mapRef = useRef<Map<string, ToolCall>>(new Map());
  const [version, setVersion] = useState(0);

  const upsertToolCall = useCallback((event: string, data: Record<string, unknown>) => {
    if (event !== 'tool.call.upsert' && event !== 'tool_call') return;

    const callId = String(data.callId ?? '');
    if (!callId) return;

    const existing = mapRef.current.get(callId);
    const status = (String(data.status ?? 'running')) as ToolCall['status'];

    const call: ToolCall = {
      callId,
      toolName: String(data.toolName ?? existing?.toolName ?? ''),
      argsPreview: typeof data.argsPreview === 'string'
        ? data.argsPreview
        : (existing?.argsPreview ?? ''),
      status,
      resultPreview: typeof data.resultPreview === 'string'
        ? data.resultPreview
        : (existing?.resultPreview),
      errorPreview: typeof data.errorPreview === 'string'
        ? data.errorPreview
        : (existing?.errorPreview),
      durationMs: typeof data.durationMs === 'number'
        ? data.durationMs
        : (existing?.durationMs),
      attempts: typeof data.attempts === 'number'
        ? data.attempts
        : (existing?.attempts),
    };

    mapRef.current.set(callId, call);
    setVersion(v => v + 1);
  }, []);

  const reset = useCallback(() => {
    mapRef.current.clear();
    setVersion(v => v + 1);
  }, []);

  // Return a snapshot Map for reading; the version counter triggers re-renders
  return {
    liveToolCalls: mapRef.current,
    version,
    upsertToolCall,
    reset,
  };
}

/**
 * Merge live tool calls into trace-derived messages.
 * Live calls take priority when they have more recent status info
 * (e.g. live says "completed" but trace still says "running").
 */
export function mergeLiveToolCalls(
  messages: Array<{ toolCalls: ToolCall[] }>,
  liveCalls: Map<string, ToolCall>,
): void {
  for (const msg of messages) {
    if (!msg.toolCalls || msg.toolCalls.length === 0) continue;
    for (let i = 0; i < msg.toolCalls.length; i++) {
      const tc = msg.toolCalls[i];
      const live = liveCalls.get(tc.callId);
      if (!live) continue;
      // Live takes priority when it progressed further
      if (statusRank(live.status) > statusRank(tc.status)) {
        msg.toolCalls[i] = { ...tc, ...live };
      } else if (statusRank(live.status) === statusRank(tc.status)) {
        // Same status but live may have extra fields (durationMs, attempts, etc.)
        msg.toolCalls[i] = { ...live, ...tc, ...live };
      }
    }
  }
  // Also inject tool calls that exist in live but not yet in trace
  // These go onto the last assistant message if there is one
  const lastAssistant = [...messages].reverse().find(m =>
    m.toolCalls !== undefined &&
    (m as unknown as { role?: string }).role === 'assistant'
  ) as unknown as { toolCalls: ToolCall[] } | undefined;
  if (lastAssistant) {
    for (const [callId, live] of liveCalls) {
      if (!lastAssistant.toolCalls.some(tc => tc.callId === callId)) {
        lastAssistant.toolCalls.push({ ...live });
      }
    }
  }
}

function statusRank(s: string): number {
  switch (s) {
    case 'running': return 1;
    case 'completed': return 2;
    case 'error': return 2;
    case 'denied': return 2;
    default: return 0;
  }
}
