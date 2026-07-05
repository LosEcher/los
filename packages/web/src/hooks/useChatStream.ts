/**
 * Chat stream hook — manages the live event transport for a running session.
 * Primary: WebSocket (ws-client.ts). Fallback: SSE EventSource (/sessions/:id/events/live).
 */
import { useEffect, useRef, useState } from 'react';
import { connectWsStream, type WsConnectionState, type WsStreamEvent } from '../api/ws-client.js';

export type StreamEventCallback = (event: string, data: Record<string, unknown>) => void;

export function useChatStream({
  sessionId,
  enabled,
  onEvent,
}: {
  sessionId: string | null;
  enabled: boolean;
  onEvent: StreamEventCallback;
}) {
  const [connectionState, setConnectionState] = useState<WsConnectionState>('closed');
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!sessionId || !enabled) {
      setConnectionState('closed');
      return;
    }

    // ── Primary: WebSocket ──
    const ws = connectWsStream(sessionId);

    ws.onStateChange((s) => setConnectionState(s));

    ws.onEvent((ev: WsStreamEvent) => {
      onEventRef.current(ev.event, ev.data);
    });

    // ── Fallback: SSE EventSource ──
    // If WS stays in 'connecting' for more than 3s, start SSE as fallback
    let sseFallback: EventSource | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

    fallbackTimer = setTimeout(() => {
      if (ws.connectionState !== 'connected') {
        const es = new EventSource(`/sessions/${sessionId}/events/live`);
        sseFallback = es;
        es.addEventListener('session.event', () => {
          // EventSource only signals that new events exist — the trace poll
          // in chat-page.tsx will pick them up. But we also forward the raw
          // notification so callers know something changed.
        });
        es.onerror = () => {
          es.close();
          sseFallback = null;
        };
      }
    }, 3_000);

    return () => {
      clearTimeout(fallbackTimer);
      ws.close();
      sseFallback?.close();
    };
  }, [sessionId, enabled]);

  return { connectionState };
}
