/**
 * Chat run hook — encapsulates the submit/stream/cancel/approval pipeline
 * extracted from chat-page.tsx to keep it under the 600-line gate.
 */
import { useState, useRef, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  postJson,
  streamChat,
  streamRuntime,
  type RuntimeKind,
  type ToolMode,
  type TodoItem,
  type WorkItemProjection,
} from '../api';
import { getCurrentProjectId } from '../api/client.js';
import {
  buildHistoryRows,
  buildTodoPrompt,
  readyStreamRows,
  streamRow,
  SUPPRESSED_STREAM_EVENTS,
  mapTraceToMessages,
  readRunContract,
  parseCommaList,
  buildModelSettingsPayload,
  buildToolRetryPayload,
  type StreamRow,
} from '../chat-helpers.js';
import {
  buildHistoryMessages,
  readyMessages,
  type Message,
} from '../chat-messages.js';
import {
  useLiveToolCalls,
  mergeLiveToolCalls,
} from './useLiveToolCalls.js';
import { useChatStream } from './useChatStream.js';
import type { ApprovalEvent } from '../chat-approval.js';

export function useChatRun(options: {
  workspaceRoot: string;
  toolMode: ToolMode;
  runtimeKind: RuntimeKind | 'los';
  maxLoops: number;
  timeoutMs: number;
  systemPrompt: string;
  allowedTools: string;
  toolRetryMaxAttempts: string;
  toolRetryBaseDelayMs: string;
  toolRetryMaxDelayMs: string;
  temperature: string;
  topP: string;
  maxTokens: string;
  presencePenalty: string;
  frequencyPenalty: string;
  provider: string;
  model: string;
  activeTodoContext: TodoItem | null;
  boundTodoId: string | null;
  onWorkItemBound?: (todo: TodoItem) => void;
  onSessionSelect: (id: string | null) => void;
  onBranchConsumed: () => void;
}) {
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<StreamRow[]>(() => readyStreamRows());
  const [messages, setMessages] = useState<Message[]>(() => readyMessages());
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [taskRunId, setTaskRunId] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [approvalEvents, setApprovalEvents] = useState<ApprovalEvent[]>([]);
  const [contextNotifs, setContextNotifs] = useState<Array<{ id: string; event: string; data: Record<string, unknown> }>>([]);
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const branchFromRef = useRef<string | null>(null);
  const runStartRef = useRef(0);
  const historyLoadedForSession = useRef<string | null>(null);
  const selectedSessionRef = useRef<string | null>(null);
  const autoWorkItemRef = useRef<TodoItem | null>(null);
  const o = options;

  const { liveToolCalls, version: liveVersion, upsertToolCall, reset: resetLiveToolCalls } = useLiveToolCalls();

  const { connectionState } = useChatStream({
    sessionId,
    enabled: running,
    onEvent: (event, data) => {
      if (['turn', 'done', 'tool.result', 'tool.call', 'tool.call.upsert', 'model.response', 'model.delta', 'context.fill'].some(e => event.startsWith(e))) {
        void queryClient.invalidateQueries({ queryKey: ['chat-session-trace', sessionId] });
        void queryClient.invalidateQueries({ queryKey: ['chat-session-observability', sessionId] });
      }
    },
  });

  // ── Stream callback ──
  const onStreamEvent = useCallback((event: string, data: Record<string, unknown>) => {
    if (event === 'session' && typeof data.sessionId === 'string') {
      setSessionId(data.sessionId);
      o.onSessionSelect(data.sessionId);
    }
    if (typeof data.taskRunId === 'string') setTaskRunId(data.taskRunId);
    if (event === 'tool.call.upsert' || event === 'tool_call') {
      upsertToolCall(event, data);
    }
    if (event === 'tool.approved' || event === 'tool.denied') {
      setApprovalEvents(prev => [...prev, {
        id: crypto.randomUUID(),
        callId: String(data.callId ?? ''),
        toolName: String(data.toolName ?? 'unknown'),
        argsPreview: typeof data.argsPreview === 'string' ? data.argsPreview : undefined,
        allowed: event === 'tool.approved',
        reason: typeof data.reason === 'string' ? data.reason : undefined,
        reasonCode: typeof data.reasonCode === 'string' ? data.reasonCode : undefined,
        capability: typeof data.capability === 'string' ? data.capability : undefined,
        createdAt: Date.now(),
      }]);
    }
    if (event.startsWith('context.fill')) {
      setContextNotifs(prev => [...prev, { id: crypto.randomUUID(), event, data }]);
    }
    if (!SUPPRESSED_STREAM_EVENTS.has(event)) {
      setRows(prev => [...prev, streamRow(event, data)]);
    }
    if (['turn', 'done', 'tool.result', 'tool.call', 'tool.call.upsert'].includes(event)) {
      void queryClient.invalidateQueries({ queryKey: ['chat-session-trace', sessionId] });
    }
  }, [o.onSessionSelect, upsertToolCall, sessionId, queryClient]);

  // ── Submit ──
  async function handleSubmit(text: string) {
    if (!text.trim() || running) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setPrompt('');
    setRunning(true);
    setCancelled(false);
    setApprovalEvents([]);
    setContextNotifs([]);
    runStartRef.current = Date.now();

    setRows(prev => {
      const hasHistory = prev.length > 0 && prev.some(r => r.event === 'history.end');
      if (hasHistory) {
        return [...prev, { id: crypto.randomUUID(), event: '---', message: 'New message below', level: 'normal' as const }, { id: crypto.randomUUID(), event: 'user', message: text }];
      }
      return [{ id: crypto.randomUUID(), event: 'user', message: text }];
    });
    setMessages(prev => {
      const hasHistory = prev.length > 0 && prev.some(m => m.role === 'separator');
      const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: text, toolCalls: [] };
      if (hasHistory) return [...prev, { id: crypto.randomUUID(), role: 'separator' as const, content: 'New message below', level: 'normal' as const, toolCalls: [] }, userMsg];
      return [userMsg];
    });

    try {
      if (o.runtimeKind === 'los') {
        // Project-write coding turns are Work-first. Keep the created item in a
        // ref so the next turn reuses it even before React state settles.
        let resolvedTodo = o.activeTodoContext ?? autoWorkItemRef.current;
        if (!resolvedTodo && o.toolMode === 'project-write') {
          const goal = text.trim();
          const created = await postJson<WorkItemProjection>('/work-items', {
            projectId: getCurrentProjectId() ?? 'los',
            title: goal.split(/\r?\n/, 1)[0]?.slice(0, 120) || 'Web coding task',
            goal,
            description: goal,
            mode: 'execution',
            editableSurfaces: o.workspaceRoot.trim() ? [o.workspaceRoot.trim()] : [],
            nonGoals: [],
            requiredChecks: [],
            stopConditions: [],
            evidenceRequired: [],
            toolMode: 'project-write',
            priority: 'P2',
          });
          resolvedTodo = workItemAsTodo(created);
          autoWorkItemRef.current = resolvedTodo;
          o.onWorkItemBound?.(resolvedTodo);
          void queryClient.invalidateQueries({ queryKey: ['work-items'] });
          void queryClient.invalidateQueries({ queryKey: ['inbox'] });
        }
        const composerPayload = {
          systemPrompt: o.systemPrompt.trim() || undefined,
          allowedTools: parseCommaList(o.allowedTools),
          toolRetry: buildToolRetryPayload({ maxAttempts: o.toolRetryMaxAttempts, baseDelayMs: o.toolRetryBaseDelayMs, maxDelayMs: o.toolRetryMaxDelayMs }),
          modelSettings: buildModelSettingsPayload({ temperature: o.temperature, topP: o.topP, maxTokens: o.maxTokens, presencePenalty: o.presencePenalty, frequencyPenalty: o.frequencyPenalty }),
        };
        await streamChat({
          prompt: text,
          sessionId: branchFromRef.current ? undefined : (sessionId ?? undefined),
          branchFrom: branchFromRef.current ?? undefined,
          systemPrompt: composerPayload.systemPrompt,
          provider: o.provider.trim() || undefined,
          model: o.model.trim() || undefined,
          modelSettings: composerPayload.modelSettings,
          workspaceRoot: o.workspaceRoot.trim() || undefined,
          toolMode: o.toolMode,
          allowedTools: composerPayload.allowedTools,
          maxLoops: o.maxLoops,
          traceId: resolvedTodo?.traceId,
          dedupeKey: resolvedTodo ? `todo:${resolvedTodo.id}:${Date.now()}` : undefined,
          timeoutMs: o.timeoutMs,
          toolRetry: composerPayload.toolRetry,
          runContract: readRunContract(resolvedTodo ?? null),
          todoId: resolvedTodo?.id,
        }, controller.signal, ({ event, data }) => onStreamEvent(event, data));
      } else {
        setRows(prev => [...prev, { id: crypto.randomUUID(), event: 'runtime.started', message: `Starting ${o.runtimeKind}...`, level: 'ok' as const }]);
        await streamRuntime({ kind: o.runtimeKind, prompt: text, workspaceRoot: o.workspaceRoot.trim() || undefined, timeoutMs: o.timeoutMs }, controller.signal, ({ event, data }) => {
          setRows(prev => [...prev, streamRow(event, data)]);
          if (event === 'runtime.completed' || event === 'runtime.error') void queryClient.invalidateQueries({ queryKey: ['sessions'] });
        });
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        const errMsg = String((err as Error).message ?? err);
        setRows(prev => [...prev, { id: crypto.randomUUID(), event: 'error', message: errMsg, level: 'error' }]);
        setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'system' as const, content: errMsg, eventType: 'error', level: 'error', toolCalls: [] }]);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
      resetLiveToolCalls();
      if (branchFromRef.current) { branchFromRef.current = null; o.onBranchConsumed(); }
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['todos'] });
      void queryClient.invalidateQueries({ queryKey: ['memory'] });
      void queryClient.invalidateQueries({ queryKey: ['chat-session', sessionId] });
      void queryClient.invalidateQueries({ queryKey: ['chat-session-trace', sessionId] });
      void queryClient.invalidateQueries({ queryKey: ['chat-session-observability', sessionId] });
    }
  }

  function requestCancel() { if (running) setShowAbortConfirm(true); }

  function dismissCancel() { setShowAbortConfirm(false); }

  async function confirmCancel() {
    setShowAbortConfirm(false);
    if (taskRunId) await postJson(`/tasks/${taskRunId}/cancel`, { reason: 'cancelled_from_web_console' }).catch(() => undefined);
    abortRef.current?.abort();
    setRunning(false);
    setCancelled(true);
  }

  function startNewChat() {
    if (running) return;
    setSessionId(null);
    setTaskRunId(null);
    autoWorkItemRef.current = null;
    setRows([{ id: crypto.randomUUID(), event: 'session.new', message: 'New chat is ready.', meta: 'next send will create a new session', level: 'ok' }]);
    setMessages([{ id: crypto.randomUUID(), role: 'system' as const, content: 'New chat is ready.', meta: 'next send will create a new session', level: 'ok', toolCalls: [] }]);
  }

  return {
    prompt, setPrompt, running, rows, setRows, messages, setMessages,
    sessionId, setSessionId, taskRunId, setTaskRunId,
    cancelled, approvalEvents, contextNotifs, showAbortConfirm,
    connectionState, liveToolCalls, liveVersion,
    abortRef, branchFromRef, runStartRef,
    historyLoadedForSession, selectedSessionRef,
    handleSubmit, requestCancel, confirmCancel, dismissCancel,
    startNewChat,
  };
}

function workItemAsTodo(item: WorkItemProjection): TodoItem {
  return {
    id: item.id,
    tenantId: item.tenantId,
    projectId: item.projectId,
    userId: item.userId,
    title: item.title,
    description: item.description,
    kind: 'task',
    status: item.status,
    priority: item.priority,
    source: item.source,
    dependsOnIds: [],
    blockedByIds: [],
    metadata: { runContract: item.runContractDraft },
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}
