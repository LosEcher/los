import { useEffect, useRef, useState } from 'react';
import type { TodoItem } from '../api';
import { buildTodoPrompt } from '../chat-helpers';
import { readyMessages, type Message } from '../chat-messages';
import type { StreamRow } from '../chat-helpers';

export function useChatSession({
  selectedSessionId,
  onSessionSelect,
  onTodoContextClear,
}: {
  selectedSessionId: string | null;
  onSessionSelect: (id: string | null) => void;
  onTodoContextClear: () => void;
}) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [taskRunId, setTaskRunId] = useState<string | null>(null);
  const [boundTodoId, setBoundTodoId] = useState<string | null>(null);
  const [newChatConfirming, setNewChatConfirming] = useState(false);
  const historyLoadedForSession = useRef<string | null>(null);

  // Session selection sync
  useEffect(() => {
    if (!selectedSessionId || selectedSessionId === sessionId) return;
    setSessionId(selectedSessionId);
    setTaskRunId(null);
    historyLoadedForSession.current = null;
  }, [selectedSessionId, sessionId]);

  // Todo context binding
  function bindTodo(todo: TodoItem) {
    if (todo.id === boundTodoId) return;
    setBoundTodoId(todo.id);
    setSessionId(todo.sessionId ?? null);
    setTaskRunId(null);
  }

  function startNewChat() {
    setSessionId(null);
    setTaskRunId(null);
    setBoundTodoId(null);
    historyLoadedForSession.current = null;
    onTodoContextClear();
    onSessionSelect(null);
    return { newChatConfirming: false };
  }

  function clearTodoBinding() {
    setBoundTodoId(null);
  }

  return {
    sessionId, setSessionId,
    taskRunId, setTaskRunId,
    boundTodoId, setBoundTodoId,
    newChatConfirming, setNewChatConfirming,
    historyLoadedForSession,
    bindTodo,
    startNewChat,
    clearTodoBinding,
  };
}
