import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  MessageSquarePlus,
  RefreshCcw,
} from 'lucide-react';
import {
  getJson,
  postJson,
  streamChat,
  type ModelSettings,
  type ProviderDiscovery,
  type ProviderModelsResponse,
  type SessionDetail,
  type SessionTraceResponse,
  type SessionObservability,
  type ToolMode,
  type TodoItem,
} from './api';
import {
  buildAdvancedCount,
  buildProviderOptions,
  buildTodoPrompt,
  readRunContract,
  readyStreamRows,
  metadataText,
  buildHistoryRows,
  streamRow,
  SUPPRESSED_STREAM_EVENTS,
  providerRoutesFromModels,
  type StreamRow,
} from './chat-helpers.js';
import {
  EmptyText,
  Fact,
  formatDate,
  formatTime,
} from './ui';
import { ContextChip } from './chat-ui.js';
import { ChatComposer, buildComposerPayload } from './chat-composer.js';
import {
  accumulateEvent,
  readyMessages,
  ChatMessages,
  type Message,
} from './chat-messages.js';

export function ChatPage({
  selectedSessionId,
  onSessionSelect,
  branchFromSession,
  onBranchConsumed,
  activeTodoContext,
  onTodoContextClear,
}: {
  selectedSessionId: string | null;
  onSessionSelect: (id: string | null) => void;
  branchFromSession: string | null;
  onBranchConsumed: () => void;
  activeTodoContext: TodoItem | null;
  onTodoContextClear: () => void;
}) {
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState('');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [workspaceRoot, setWorkspaceRoot] = useState(() => {
    try { return localStorage.getItem('los-workspace') ?? ''; } catch { return ''; }
  });
  const [toolMode, setToolMode] = useState<ToolMode>('project-write');
  const [maxLoops, setMaxLoops] = useState(20); // default from infra/config.ts, overridden by /settings
  const [timeoutMs, setTimeoutMs] = useState(120_000);
  const [temperature, setTemperature] = useState('');
  const [topP, setTopP] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [presencePenalty, setPresencePenalty] = useState('');
  const [frequencyPenalty, setFrequencyPenalty] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [allowedTools, setAllowedTools] = useState('');
  const [toolRetryMaxAttempts, setToolRetryMaxAttempts] = useState('');
  const [toolRetryBaseDelayMs, setToolRetryBaseDelayMs] = useState('');
  const [toolRetryMaxDelayMs, setToolRetryMaxDelayMs] = useState('');
  const [running, setRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [taskRunId, setTaskRunId] = useState<string | null>(null);
  const [boundTodoId, setBoundTodoId] = useState<string | null>(null);
  const [rows, setRows] = useState<StreamRow[]>(() => readyStreamRows());
  const [messages, setMessages] = useState<Message[]>(() => readyMessages());
  const [debugMode, setDebugMode] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const historyLoadedForSession = useRef<string | null>(null);
  const branchFromRef = useRef<string | null>(null);

  const onboarding = useQuery({
    queryKey: ['onboarding'],
    queryFn: () => getJson<ProviderDiscovery>('/onboarding'),
    staleTime: 20_000,
  });
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => getJson<Record<string, unknown>>('/settings'),
    staleTime: 60_000,
  });
  const configMaxLoops = (settings.data as Record<string, Record<string, unknown>> | undefined)?.agent?.maxLoops;
  const defaultMaxLoops = typeof configMaxLoops === 'number' ? configMaxLoops : 20;
  const modelRoutes = useQuery({
    queryKey: ['provider-models', provider || 'default'],
    queryFn: () => getJson<ProviderModelsResponse>(
      provider ? `/providers/models?provider=${encodeURIComponent(provider)}` : '/providers/models',
    ),
    staleTime: 20_000,
  });
  const workspaceInfo = useQuery({
    queryKey: ['workspace'],
    queryFn: () => getJson<{ workspaceRoot: string; cwd: string }>('/workspace'),
    staleTime: 60_000,
  });
  const defaultWorkspace = workspaceInfo.data?.workspaceRoot ?? '';
  const sessionDetail = useQuery({
    queryKey: ['chat-session', sessionId],
    queryFn: () => getJson<SessionDetail>(`/sessions/${sessionId}`),
    enabled: Boolean(sessionId),
    refetchInterval: running ? 4_000 : false,
  });
  const sessionTrace = useQuery({
    queryKey: ['chat-session-trace', sessionId],
    queryFn: () => getJson<SessionTraceResponse>(`/sessions/${sessionId}/trace`),
    enabled: Boolean(sessionId),
    refetchInterval: running ? 4_000 : false,
  });
  // Live event push via EventSource
  useEffect(() => {
    if (!sessionId || !running) return;
    const es = new EventSource(`/sessions/${sessionId}/events/live`);
    const onSessionEvent = () => {
      void queryClient.invalidateQueries({ queryKey: ['chat-session-trace', sessionId] });
      void queryClient.invalidateQueries({ queryKey: ['chat-session-observability', sessionId] });
    };
    es.addEventListener('session.event', onSessionEvent);
    es.onerror = () => {
      es.close();
      void queryClient.invalidateQueries({ queryKey: ['chat-session-trace', sessionId] });
    };
    return () => {
      es.removeEventListener('session.event', onSessionEvent);
      es.close();
    };
  }, [sessionId, running, queryClient]);
  const sessionObservability = useQuery({
    queryKey: ['chat-session-observability', sessionId],
    queryFn: () => getJson<SessionObservability>(`/sessions/${sessionId}/observability`),
    enabled: Boolean(sessionId),
    refetchInterval: running ? 4_000 : false,
  });

  const providerOptions = useMemo(() => {
    return buildProviderOptions(onboarding.data, modelRoutes.data);
  }, [onboarding.data, modelRoutes.data]);
  const providerRoutes = useMemo(() => providerRoutesFromModels(modelRoutes.data), [modelRoutes.data]);
  const selectedRoute = useMemo(() => {
    return providerRoutes.find(route => route.provider === provider) ?? providerRoutes[0] ?? null;
  }, [providerRoutes, provider]);
  const modelOptions = useMemo(() => {
    const ids = new Set<string>();
    if (selectedRoute?.model) ids.add(selectedRoute.model);
    for (const item of selectedRoute?.models ?? []) {
      if (item.id) ids.add(item.id);
    }
    return [...ids];
  }, [selectedRoute]);
  const advancedCount = useMemo(() => {
    return buildAdvancedCount({
      systemPrompt,
      allowedTools,
      maxLoops,
      timeoutMs,
      toolRetryMaxAttempts,
      toolRetryBaseDelayMs,
      toolRetryMaxDelayMs,
      temperature,
      topP,
      maxTokens,
      presencePenalty,
      frequencyPenalty,
    });
  }, [systemPrompt, allowedTools, maxLoops, timeoutMs, toolRetryMaxAttempts, toolRetryBaseDelayMs, toolRetryMaxDelayMs, temperature, topP, maxTokens, presencePenalty, frequencyPenalty]);
  const sessionMetadata = sessionDetail.data?.metadata ?? {};
  function mapTraceMessages(input: SessionTraceResponse['messages']): Message[] {
    return input.map((msg, idx) => ({
      id: `${sessionId ?? 'no-session'}:${idx}:${msg.role}:${msg.turnIndex ?? ''}:${msg.eventType ?? ''}`,
      role: msg.role,
      content: msg.content,
      meta: msg.meta,
      level: msg.level,
      eventType: msg.eventType,
      provider: msg.provider,
      model: msg.model,
      turnIndex: msg.turnIndex,
      totalTurns: msg.totalTurns,
      reasoning: msg.reasoning,
      toolCalls: msg.toolCalls.map(tc => ({
        callId: tc.callId,
        toolName: tc.toolName,
        status: tc.status,
        argsPreview: tc.argsPreview,
        args: tc.args,
        resultPreview: tc.resultPreview,
        errorPreview: tc.errorPreview,
        durationMs: tc.durationMs,
        attempts: tc.attempts,
      })),
    }));
  }

  // Persist workspaceRoot to localStorage
  useEffect(() => {
    try { localStorage.setItem('los-workspace', workspaceRoot); } catch {}
  }, [workspaceRoot]);

  useEffect(() => {
    if (running) return;
    if (!selectedSessionId || selectedSessionId === sessionId) return;
    setSessionId(selectedSessionId);
    setTaskRunId(null);
    historyLoadedForSession.current = null;
    setRows([{
      id: crypto.randomUUID(),
      event: 'session.loading',
      message: `Loading session ${selectedSessionId}...`,
      level: 'normal',
    }]);
    setMessages([{
      id: crypto.randomUUID(),
      role: 'system' as const,
      content: `Loading session ${selectedSessionId}...`,
      eventType: 'session.loading',
      toolCalls: [],
    }]);
  }, [selectedSessionId, sessionId, running]);

  // When session detail loads for a resumed session, render history in the chat
  useEffect(() => {
    if (running) return;
    if (!sessionId || sessionId !== selectedSessionId) return;
    if (historyLoadedForSession.current === sessionId) return;
    const trace = sessionTrace.data;
    if (!trace || !Array.isArray(trace.messages) || trace.messages.length === 0) return;
    historyLoadedForSession.current = sessionId;
    const detail = sessionDetail.data;
    const messages_ = detail?.messages ?? [];
    const turns_ = detail?.turns ?? [];
    const historyRows = buildHistoryRows(messages_ as Array<Record<string, unknown>>, turns_ as Array<Record<string, unknown>>);
    setRows(historyRows);
    setMessages(mapTraceMessages(trace.messages));
  }, [sessionDetail.data, sessionTrace.data, sessionId, selectedSessionId, running]);

  // When branchFromSession is set, prepare chat for a branch
  useEffect(() => {
    if (running || !branchFromSession) return;
    branchFromRef.current = branchFromSession;
    setSessionId(null);
    setTaskRunId(null);
    historyLoadedForSession.current = null;
    setRows([{
      id: crypto.randomUUID(),
      event: 'session.branch',
      message: `Branching from ${branchFromSession}. Enter your prompt to start.`,
      level: 'ok',
    }]);
    setMessages([{
      id: crypto.randomUUID(),
      role: 'system' as const,
      content: `Branching from ${branchFromSession}. Enter your prompt to start.`,
      eventType: 'session.branch',
      level: 'ok',
      toolCalls: [],
    }]);
    // Load parent session to show history context
    Promise.all([
      getJson<SessionDetail>(`/sessions/${branchFromSession}`),
      getJson<SessionTraceResponse>(`/sessions/${branchFromSession}/trace`),
    ]).then(([detail, trace]) => {
      if (detail && Array.isArray(detail.messages) && detail.messages.length > 0) {
        const msgs = detail.messages as Array<Record<string, unknown>>;
        const turns = Array.isArray(detail.turns) ? (detail.turns as Array<Record<string, unknown>>) : [];
        const historyRows = buildHistoryRows(msgs, turns);
        setRows(prev => {
          if (!branchFromRef.current) return prev;
          return historyRows;
        });
        setMessages(prev => {
          if (!branchFromRef.current) return prev;
          return trace?.messages ? mapTraceMessages(trace.messages) : prev;
        });
      }
    }).catch(() => undefined);
  }, [branchFromSession, running]);

  useEffect(() => {
    if (running || !activeTodoContext || activeTodoContext.id === boundTodoId) return;
    setBoundTodoId(activeTodoContext.id);
    setSessionId(activeTodoContext.sessionId ?? null);
    setTaskRunId(null);
    setPrompt(buildTodoPrompt(activeTodoContext));
    setRows([{
      id: crypto.randomUUID(),
      event: 'todo.selected',
      message: activeTodoContext.title,
      meta: activeTodoContext.id,
      level: 'ok',
    }]);
    setMessages([{
      id: crypto.randomUUID(),
      role: 'system' as const,
      content: activeTodoContext.title,
      meta: activeTodoContext.id,
      level: 'ok',
      toolCalls: [],
    }]);
  }, [activeTodoContext, boundTodoId, running, sessionId]);

  useEffect(() => {
    if (provider || providerOptions.length === 0) return;
    if (!modelRoutes.data && !modelRoutes.isError) return;
    setProvider(providerOptions[0]!.id);
  }, [modelRoutes.data, modelRoutes.isError, provider, providerOptions]);

  useEffect(() => {
    if (!selectedRoute) return;
    const fallback = selectedRoute.model ?? modelOptions[0] ?? '';
    if (!fallback) return;
    if (!model || (modelOptions.length > 0 && !modelOptions.includes(model))) {
      setModel(fallback);
    }
  }, [model, modelOptions, selectedRoute]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || running) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setPrompt('');
    setRunning(true);
    // Preserve history rows if continuing a session, otherwise start fresh
    setRows(prev => {
      const hasHistory = prev.length > 0 && prev.some(r => r.event === 'history.end');
      if (hasHistory) {
        return [...prev, {
          id: crypto.randomUUID(),
          event: '---',
          message: 'New message below',
          level: 'normal' as const,
        }, {
          id: crypto.randomUUID(),
          event: 'user',
          message: text,
        }];
      }
      return [{ id: crypto.randomUUID(), event: 'user', message: text }];
    });
    setMessages(prev => {
      const hasHistory = prev.length > 0 && prev.some(m => m.role === 'separator');
      const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: text, toolCalls: [] };
      if (hasHistory) {
        return [...prev, {
          id: crypto.randomUUID(),
          role: 'separator' as const,
          content: 'New message below',
          level: 'normal' as const,
          toolCalls: [],
        }, userMsg];
      }
      return [userMsg];
    });

    try {
      const composer = buildComposerPayload({
        systemPrompt,
        allowedTools,
        toolRetryMaxAttempts,
        toolRetryBaseDelayMs,
        toolRetryMaxDelayMs,
        temperature,
        topP,
        maxTokens,
        presencePenalty,
        frequencyPenalty,
      });
      await streamChat({
        prompt: text,
        sessionId: branchFromRef.current ? undefined : (sessionId ?? undefined),
        branchFrom: branchFromRef.current ?? undefined,
        systemPrompt: composer.systemPrompt,
        provider: provider.trim() || undefined,
        model: model.trim() || undefined,
        modelSettings: composer.modelSettings,
        workspaceRoot: workspaceRoot.trim() || undefined,
        toolMode,
        allowedTools: composer.allowedTools,
        maxLoops,
        traceId: activeTodoContext?.traceId,
        dedupeKey: activeTodoContext ? `todo:${activeTodoContext.id}:${Date.now()}` : undefined,
        timeoutMs,
        toolRetry: composer.toolRetry,
        runContract: readRunContract(activeTodoContext),
        todoId: activeTodoContext?.id,
      }, controller.signal, ({ event, data }) => {
        if (event === 'session' && typeof data.sessionId === 'string') {
          setSessionId(data.sessionId);
          onSessionSelect(data.sessionId);
        }
        if (typeof data.taskRunId === 'string') setTaskRunId(data.taskRunId);
        if (!SUPPRESSED_STREAM_EVENTS.has(event)) {
          setRows(prev => [...prev, streamRow(event, data)]);
        }
        setMessages(prev => accumulateEvent(prev, event, data));
      });
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        const errMsg = String((err as Error).message ?? err);
        setRows(prev => [...prev, {
          id: crypto.randomUUID(),
          event: 'error',
          message: errMsg,
          level: 'error',
        }]);
        setMessages(prev => [...prev, {
          id: crypto.randomUUID(),
          role: 'system' as const,
          content: errMsg,
          eventType: 'error',
          level: 'error',
          toolCalls: [],
        }]);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
      if (branchFromRef.current) {
        branchFromRef.current = null;
        onBranchConsumed();
      }
      await queryClient.invalidateQueries({ queryKey: ['sessions'] });
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
      await queryClient.invalidateQueries({ queryKey: ['todos'] });
      await queryClient.invalidateQueries({ queryKey: ['memory'] });
      await queryClient.invalidateQueries({ queryKey: ['chat-session', sessionId] });
      await queryClient.invalidateQueries({ queryKey: ['chat-session-trace', sessionId] });
      await queryClient.invalidateQueries({ queryKey: ['chat-session-observability', sessionId] });
    }
  }

  async function cancelRun() {
    if (taskRunId) {
      await postJson(`/tasks/${taskRunId}/cancel`, { reason: 'cancelled_from_web_console' }).catch(() => undefined);
    }
    abortRef.current?.abort();
    setRunning(false);
  }

  const [newChatConfirming, setNewChatConfirming] = useState(false);

  function startNewChat() {
    if (running) return;
    if (sessionId || taskRunId) {
      if (!newChatConfirming) {
        setNewChatConfirming(true);
        return;
      }
      setNewChatConfirming(false);
    }
    setSessionId(null);
    setTaskRunId(null);
    setBoundTodoId(null);
    historyLoadedForSession.current = null;
    onTodoContextClear();
    setRows([{
      id: crypto.randomUUID(),
      event: 'session.new',
      message: 'New chat is ready.',
      meta: 'next send will create a new session',
      level: 'ok',
    }]);
    setMessages([{
      id: crypto.randomUUID(),
      role: 'system' as const,
      content: 'New chat is ready.',
      meta: 'next send will create a new session',
      level: 'ok',
      toolCalls: [],
    }]);
    onSessionSelect(null);
  }

  return (
    <section className="panel-grid chat-grid">
      <div className="panel main-panel">
        <div className="panel-head">
          <div>
            <h2>Chat Run</h2>
            <p>Current run controls feed Gateway `/chat`; session evidence stays in the ledger.</p>
          </div>
          <div className="toolbar">
            <button className={`ghost-btn${newChatConfirming ? ' danger' : ''}`} type="button" disabled={running} onClick={startNewChat}>
              <MessageSquarePlus size={14} /> {newChatConfirming ? 'confirm new?' : 'new chat'}
            </button>
            <button className="ghost-btn" type="button" onClick={() => { setRows([]); setMessages([]); }}>
              <RefreshCcw size={14} /> clear
            </button>
          </div>
        </div>

        <div className="chat-context-bar">
          <ContextChip label="session" value={sessionId ?? 'new'} tone={sessionId ? 'ok' : undefined} />
          {activeTodoContext ? <ContextChip label="todo" value={activeTodoContext.id} tone="ok" /> : null}
          <ContextChip label="provider" value={provider || 'default'} />
          <ContextChip label="model" value={model || 'provider default'} />
          <ContextChip label="task" value={taskRunId ?? (running ? 'starting' : 'idle')} tone={running ? 'warn' : undefined} />
        </div>

        <ChatMessages
          messages={messages}
          debugMode={debugMode}
          onDebugModeChange={setDebugMode}
        >
          {rows.length === 0 ? <EmptyText text="No stream events yet." /> : rows.map(row => (
            <div className={`stream-row${row.event === '---' || row.event === 'history.end' ? ' stream-separator' : ''}`} data-level={row.level ?? 'normal'} key={row.id}>
              <span className="stream-event">{row.event}</span>
              <div>
                <p>{row.message}</p>
                {row.meta ? <code>{row.meta}</code> : null}
              </div>
            </div>
          ))}
        </ChatMessages>
        <ChatComposer
          prompt={prompt}
          onPromptChange={setPrompt}
          onSubmit={handleSubmit}
          onCancel={cancelRun}
          running={running}
          provider={provider}
          onProviderChange={setProvider}
          providerOptions={providerOptions}
          model={model}
          onModelChange={setModel}
          modelRoutes={modelRoutes.data}
          toolMode={toolMode}
          onToolModeChange={setToolMode}
          allowedTools={allowedTools}
          onAllowedToolsChange={setAllowedTools}
          workspaceRoot={workspaceRoot}
          onWorkspaceRootChange={setWorkspaceRoot}
          defaultWorkspace={defaultWorkspace}
          systemPrompt={systemPrompt}
          onSystemPromptChange={setSystemPrompt}
          maxLoops={maxLoops}
          onMaxLoopsChange={setMaxLoops}
          timeoutMs={timeoutMs}
          onTimeoutMsChange={setTimeoutMs}
          toolRetryMaxAttempts={toolRetryMaxAttempts}
          toolRetryBaseDelayMs={toolRetryBaseDelayMs}
          toolRetryMaxDelayMs={toolRetryMaxDelayMs}
          onToolRetryMaxAttemptsChange={setToolRetryMaxAttempts}
          onToolRetryBaseDelayMsChange={setToolRetryBaseDelayMs}
          onToolRetryMaxDelayMsChange={setToolRetryMaxDelayMs}
          temperature={temperature}
          topP={topP}
          maxTokens={maxTokens}
          presencePenalty={presencePenalty}
          frequencyPenalty={frequencyPenalty}
          onTemperatureChange={setTemperature}
          onTopPChange={setTopP}
          onMaxTokensChange={setMaxTokens}
          onPresencePenaltyChange={setPresencePenalty}
          onFrequencyPenaltyChange={setFrequencyPenalty}
          advancedCount={advancedCount}
        />
      </div>

      <aside className="panel inspector">
        <div className="panel-head compact">
          <h2>Run Evidence</h2>
          <Activity size={16} />
        </div>
        <div className="fact-list compact-facts">
          <Fact label="session" value={sessionId ?? 'not started'} />
          <Fact label="task run" value={taskRunId ?? (running ? 'starting' : 'idle')} />
          <Fact label="last provider" value={metadataText(sessionMetadata.provider) ?? 'none'} />
          <Fact label="last model" value={metadataText(sessionMetadata.model) ?? 'none'} />
          <Fact label="settings" value={metadataText(JSON.stringify(sessionMetadata.modelSettings ?? {})) ?? '{}'} />
          <Fact label="tokens" value={String(sessionObservability.data?.totalUsage.totalTokens ?? 0)} />
        </div>
      </aside>
    </section>
  );
}
