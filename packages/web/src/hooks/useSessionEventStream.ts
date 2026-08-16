/**
 * useSessionEventStream — SessionInspector 流式事件源。
 *
 * 替代整段轮询重载（G4）：
 * - 初次全量：GET /sessions/:id/events?limit=300，记住高水位 lastId；
 * - 实时增量：WS /sessions/:id/stream/ws?since=<lastId>（服务端回放 + 事件总线推送），
 *   按事件 id 去重追加，不整段闪烁；
 * - 兜底增量：WS 未连接（connecting 超时 / reconnecting / closed）时，
 *   每 5s GET /sessions/:id/events?since=<lastId> 拉增量；
 * - 向前分页：loadEarlier() 用 before=<minId> 拉更早窗口前置拼接。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getJson, type SessionEvent, type SessionEventsResponse } from '../api';
import { connectWsStream, type WsConnectionState, type WsStreamEvent } from '../api/ws-client.js';

const INITIAL_PAGE_SIZE = 300;
const INCREMENTAL_PAGE_SIZE = 100;
const EARLIER_PAGE_SIZE = 100;
/** 内存中保留的最大事件数（超出丢弃最旧，避免长会话无界增长）。 */
const MAX_CACHED_EVENTS = 800;
/** WS 未进入 connected 前的兜底轮询间隔。 */
const FALLBACK_POLL_MS = 5_000;
const WS_CONNECT_GRACE_MS = 3_000;

export type SessionEventStreamState = {
  events: SessionEvent[];
  loading: boolean;
  loadingEarlier: boolean;
  hasMoreEarlier: boolean;
  error: string | null;
  /** WS 连接状态：'connected' 实时 / 'reconnecting' 追赶 / 'closed' 仅轮询。 */
  wsState: WsConnectionState;
  /** 已加载的最早事件 id（用于 loadEarlier 的 before 游标）。 */
  minEventId: number | null;
  /** 已加载的最新事件 id（高水位）。 */
  maxEventId: number | null;
};

function mergeEvents(existing: SessionEvent[], incoming: SessionEvent[]): SessionEvent[] {
  if (incoming.length === 0) return existing;
  const byId = new Map<number, SessionEvent>();
  for (const event of existing) byId.set(event.id, event);
  for (const event of incoming) {
    // WS 消息可能携带 eventId 与 data.id 不一致的旧格式；以 data.id 为准。
    if (event && typeof event.id === 'number') byId.set(event.id, event);
  }
  const merged = [...byId.values()].sort((a, b) => a.id - b.id);
  return merged.length > MAX_CACHED_EVENTS ? merged.slice(merged.length - MAX_CACHED_EVENTS) : merged;
}

function eventFromWsMessage(ev: WsStreamEvent): SessionEvent | null {
  const data = ev.data ?? {};
  const id = typeof data.id === 'number' ? data.id : undefined;
  if (id === undefined) return null;
  return {
    id,
    sessionId: String(data.sessionId ?? ''),
    turn: Number(data.turn ?? 0),
    type: String(data.type ?? ev.event ?? 'unknown'),
    source: String(data.source ?? 'los'),
    model: typeof data.model === 'string' ? data.model : undefined,
    toolName: typeof data.toolName === 'string' ? data.toolName : undefined,
    usage: (data.usage as SessionEvent['usage']) ?? undefined,
    payload: (data.payload as Record<string, unknown>) ?? {},
    createdAt: String(data.createdAt ?? new Date().toISOString()),
  };
}

export function useSessionEventStream(sessionId: string | null): SessionEventStreamState & {
  loadEarlier: () => void;
} {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [hasMoreEarlier, setHasMoreEarlier] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wsState, setWsState] = useState<WsConnectionState>('closed');
  const lastIdRef = useRef(0);
  const minIdRef = useRef<number | null>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // ── 初次全量 + WS 实时增量 ──
  useEffect(() => {
    if (!sessionId) {
      setEvents([]);
      lastIdRef.current = 0;
      minIdRef.current = null;
      setWsState('closed');
      setHasMoreEarlier(false);
      return;
    }

    let cancelled = false;
    let ws: ReturnType<typeof connectWsStream> | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    // 捕获收窄后的 sessionId：嵌套函数（ensurePoll）不继承控制流收窄。
    const sid = sessionId;

    setLoading(true);
    setError(null);

    (async () => {
      try {
        const page = await getJson<SessionEventsResponse>(
          `/sessions/${encodeURIComponent(sid)}/events?limit=${INITIAL_PAGE_SIZE}`,
        );
        if (cancelled) return;
        const initial = page.events ?? [];
        setEvents(initial);
        lastIdRef.current = initial.length > 0 ? initial[initial.length - 1].id : 0;
        minIdRef.current = initial.length > 0 ? initial[0].id : null;
        setHasMoreEarlier(initial.length === INITIAL_PAGE_SIZE);
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? 'Failed to load events');
      } finally {
        if (!cancelled) setLoading(false);
      }

      // ── WS 实时增量（服务端按 since 回放 + 事件总线推送）──
      ws = connectWsStream(sid, lastIdRef.current);
      ws.onStateChange(state => {
        if (cancelled) return;
        setWsState(state);
        // 连接建立后停止兜底轮询（事件总线推送为主）；断线后恢复轮询。
        if (state === 'connected') {
          if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
        } else if (state === 'reconnecting' || state === 'closed') {
          ensurePoll();
        }
      });
      ws.onEvent((ev: WsStreamEvent) => {
        if (cancelled || ev.event === 'session.resumed' || ev.event === 'error') return;
        const event = eventFromWsMessage(ev);
        if (!event) return;
        if (event.id <= lastIdRef.current) return; // 去重：同 id 已处理
        lastIdRef.current = event.id;
        setEvents(prev => mergeEvents(prev, [event]));
      });

      function ensurePoll() {
        if (pollTimer || cancelled) return;
        pollTimer = setInterval(async () => {
          try {
            const page = await getJson<SessionEventsResponse>(
              `/sessions/${encodeURIComponent(sid)}/events?since=${lastIdRef.current}&limit=${INCREMENTAL_PAGE_SIZE}`,
            );
            if (cancelled) return;
            const incoming = (page.events ?? []).filter(e => e.id > lastIdRef.current);
            if (incoming.length === 0) return;
            lastIdRef.current = page.nextSince ?? incoming[incoming.length - 1].id;
            setEvents(prev => mergeEvents(prev, incoming));
          } catch {
            // 轮询失败非致命，下个周期重试
          }
        }, FALLBACK_POLL_MS);
      }

      // WS 迟迟未连接（网络/代理场景）时启用轮询兜底
      fallbackTimer = setTimeout(() => {
        if (!cancelled && ws?.connectionState !== 'connected') ensurePoll();
      }, WS_CONNECT_GRACE_MS);
    })();

    return () => {
      cancelled = true;
      clearTimeout(fallbackTimer);
      if (pollTimer) clearInterval(pollTimer);
      ws?.close();
    };
  }, [sessionId]);

  // ── 向前分页（加载更早事件）──
  const loadEarlier = useCallback(() => {
    const sessionId = sessionIdRef.current;
    const minId = minIdRef.current;
    if (!sessionId || minId === null || loadingEarlier) return;
    setLoadingEarlier(true);
    getJson<SessionEventsResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/events?before=${minId}&limit=${EARLIER_PAGE_SIZE}`,
    )
      .then(page => {
        const older = page.events ?? [];
        if (older.length === 0) {
          setHasMoreEarlier(false);
          return;
        }
        setEvents(prev => mergeEvents(older, prev));
        minIdRef.current = Math.min(minId, older[0].id);
        setHasMoreEarlier(Boolean(page.hasMore) && older.length === EARLIER_PAGE_SIZE);
      })
      .catch((err: any) => setError(err?.message ?? 'Failed to load earlier events'))
      .finally(() => setLoadingEarlier(false));
  }, [loadingEarlier]);

  return {
    events,
    loading,
    loadingEarlier,
    hasMoreEarlier,
    error,
    wsState,
    minEventId: minIdRef.current,
    maxEventId: lastIdRef.current || null,
    loadEarlier,
  };
}
