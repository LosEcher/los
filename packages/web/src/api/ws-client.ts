/**
 * WebSocket client for los session event streams.
 * Connects to GET /sessions/:id/stream/ws (NDJSON transport).
 * Provides reconnection with backoff and since-based catch-up replay.
 */

export type WsConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed';

export type WsStreamEvent = {
  event: string;
  data: Record<string, unknown>;
  id?: number;
};

export type WsStreamHandle = {
  close: () => void;
  onEvent: (cb: (ev: WsStreamEvent) => void) => void;
  onStateChange: (cb: (state: WsConnectionState) => void) => void;
  connectionState: WsConnectionState;
};

export function connectWsStream(
  sessionId: string,
  since?: number,
): WsStreamHandle {
  let state: WsConnectionState = 'connecting';
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let lastId = since ?? 0;
  let closed = false;
  const eventCbs = new Set<(ev: WsStreamEvent) => void>();
  const stateCbs = new Set<(state: WsConnectionState) => void>();

  function setState(next: WsConnectionState) {
    if (state === next || closed) return;
    state = next;
    for (const cb of stateCbs) cb(state);
  }

  function connect() {
    if (closed) return;
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const sinceParam = lastId > 0 ? `?since=${lastId}` : '';
    const url = `${protocol}://${location.host}/sessions/${sessionId}/stream/ws${sinceParam}`;

    try {
      socket = new WebSocket(url);
    } catch {
      // WebSocket constructor can throw if URL is invalid
      fallbackOrRetry();
      return;
    }

    socket.onopen = () => {
      reconnectAttempt = 0;
      setState('connected');
    };

    socket.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(String(msg.data)) as WsStreamEvent;
        if (parsed.event === 'ping') return; // server heartbeat, ignore
        if (parsed.event === 'session_stream_conflict') {
          // Lease conflict — another client owns this stream
          setState('closed');
          closed = true;
          socket?.close();
          return;
        }
        if (typeof parsed.id === 'number' && parsed.id > lastId) {
          lastId = parsed.id;
        }
        for (const cb of eventCbs) cb(parsed);
      } catch {
        // Skip unparseable messages
      }
    };

    socket.onclose = () => {
      if (closed) return;
      if (state === 'connected') {
        fallbackOrRetry();
      }
    };

    socket.onerror = () => {
      // onclose will fire after this
    };
  }

  function fallbackOrRetry() {
    if (closed) return;
    const delay = backoffMs(reconnectAttempt);
    reconnectAttempt++;
    setState('reconnecting');
    reconnectTimer = setTimeout(() => {
      if (!closed) connect();
    }, delay);
  }

  function close() {
    closed = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    if (socket) {
      socket.onclose = null; // prevent retry
      socket.close();
      socket = null;
    }
    setState('closed');
  }

  connect();

  return {
    close,
    onEvent(cb) { eventCbs.add(cb); },
    onStateChange(cb) { stateCbs.add(cb); },
    get connectionState() { return state; },
  };
}

function backoffMs(attempt: number): number {
  // 1s, 2s, 4s, 8s, 16s, max 30s
  const ms = Math.min(1000 * Math.pow(2, attempt), 30_000);
  // Add ±20% jitter
  return ms * (0.8 + Math.random() * 0.4);
}
