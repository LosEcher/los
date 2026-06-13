import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getJson, type SessionDetail, type SessionTraceResponse } from '../api';
import { buildHistoryRows, mapTraceToMessages, readyStreamRows, type StreamRow } from '../chat-helpers';
import { readyMessages, type Message } from '../chat-messages';

export function useChatHistory({
  sessionId,
  selectedSessionId,
  branchFromSession,
  sessionDetail,
  sessionTrace,
  running,
  loadedRef,
}: {
  sessionId: string | null;
  selectedSessionId: string | null;
  branchFromSession: string | null;
  sessionDetail: { data?: SessionDetail };
  sessionTrace: { data?: SessionTraceResponse };
  running: boolean;
  loadedRef: React.MutableRefObject<string | null>;
}) {
  const setRowsRef = useRef<((updater: StreamRow[] | ((prev: StreamRow[]) => StreamRow[])) => void) | null>(null);
  const setMessagesRef = useRef<((updater: Message[] | ((prev: Message[]) => Message[])) => void) | null>(null);

  function registerSetters(
    setRows: (updater: StreamRow[] | ((prev: StreamRow[]) => StreamRow[])) => void,
    setMessages: (updater: Message[] | ((prev: Message[]) => Message[])) => void,
  ) {
    setRowsRef.current = setRows;
    setMessagesRef.current = setMessages;
    return { setRows, setMessages };
  }

  // History loading when session detail + trace arrive
  useEffect(() => {
    if (running) return;
    if (!sessionId || sessionId !== selectedSessionId) return;
    if (loadedRef.current === sessionId) return;
    const trace = sessionTrace.data;
    if (!trace || !Array.isArray(trace.messages) || trace.messages.length === 0) return;
    loadedRef.current = sessionId;
    const detail = sessionDetail.data;
    const msgs = detail?.messages ?? [];
    const turns = detail?.turns ?? [];
    const historyRows = buildHistoryRows(msgs as Array<Record<string, unknown>>, turns as Array<Record<string, unknown>>);
    setRowsRef.current?.(historyRows);
    setMessagesRef.current?.(mapTraceToMessages(trace.messages, sessionId));
  }, [sessionDetail.data, sessionTrace.data, sessionId, selectedSessionId, running, loadedRef]);

  // Branch-from parent session loading
  useEffect(() => {
    if (running || !branchFromSession) return;
    Promise.all([
      getJson<SessionDetail>(`/sessions/${branchFromSession}`),
      getJson<SessionTraceResponse>(`/sessions/${branchFromSession}/trace`),
    ]).then(([detail, trace]) => {
      if (detail && Array.isArray(detail.messages) && detail.messages.length > 0) {
        const msgs = detail.messages as Array<Record<string, unknown>>;
        const turns = Array.isArray(detail.turns) ? (detail.turns as Array<Record<string, unknown>>) : [];
        const historyRows = buildHistoryRows(msgs, turns);
        setRowsRef.current?.(() => historyRows);
        setMessagesRef.current?.(prev => {
          if (trace?.messages) return mapTraceToMessages(trace.messages, sessionId);
          return prev;
        });
      }
    }).catch(() => undefined);
  }, [branchFromSession, running, sessionId]);

  return { registerSetters };
}
