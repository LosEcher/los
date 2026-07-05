import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Folder,
  MessageSquarePlus,
  RefreshCcw,
} from 'lucide-react';
import {
  getJson,
  type RuntimeKind,
  type SessionDetail,
  type SessionTraceResponse,
  type SessionObservability,
  type ToolMode,
  type TodoItem,
} from './api';
import {
  buildAdvancedCount,
  buildTodoPrompt,
  metadataText,
  buildHistoryRows,
  mapTraceToMessages,
  type StreamRow,
} from './chat-helpers.js';
import { EmptyText, Fact } from './ui';
import { ContextChip } from './chat-ui.js';
import { ChatComposer } from './chat-composer.js';
import type { ChatAdvancedSettingsState } from './chat-advanced-settings.js';
import { ChatMessages } from './chat-messages.js';
import { useChatProviders } from './hooks/useChatProviders.js';
import { useChatSession } from './hooks/useChatSession.js';
import { mergeLiveToolCalls } from './hooks/useLiveToolCalls.js';
import { useChatRun } from './hooks/useChatRun.js';
import {
  ApprovalCard,
  ContextNotification,
  CancelledBanner,
  AbortConfirmation,
} from './chat-approval.js';
import { FilesPanel } from './chat-files-panel.js';

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
  const [workspaceRoot, setWorkspaceRoot] = useState(() => {
    try { return localStorage.getItem('los-workspace') ?? ''; } catch { return ''; }
  });
  const [toolMode, setToolMode] = useState<ToolMode>('project-write');
  const [runtimeKind, setRuntimeKind] = useState<RuntimeKind | 'los'>('los');
  const [maxLoops, setMaxLoops] = useState(20);
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
  const [debugMode, setDebugMode] = useState(false);
  const [showFiles, setShowFiles] = useState(false);

  const {
    provider, setProvider,
    model, setModel,
    modelRoutes,
    providerOptions,
  } = useChatProviders();

  const {
    sessionId: hookSessionId, setSessionId: setHookSessionId,
    taskRunId, setTaskRunId,
    boundTodoId, setBoundTodoId,
    newChatConfirming, setNewChatConfirming,
    bindTodo,
    startNewChat: startNewChatFromHook,
  } = useChatSession({ selectedSessionId, onSessionSelect, onTodoContextClear });

  const run = useChatRun({
    workspaceRoot, toolMode, runtimeKind, maxLoops, timeoutMs,
    systemPrompt, allowedTools,
    toolRetryMaxAttempts, toolRetryBaseDelayMs, toolRetryMaxDelayMs,
    temperature, topP, maxTokens, presencePenalty, frequencyPenalty,
    provider, model,
    activeTodoContext, boundTodoId,
    onSessionSelect, onBranchConsumed,
  });

  // Sync hook sessionId with run sessionId
  useEffect(() => {
    if (run.sessionId && run.sessionId !== hookSessionId) {
      setHookSessionId(run.sessionId);
    }
  }, [run.sessionId]);

  const sessionId = run.sessionId ?? hookSessionId;

  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => getJson<Record<string, unknown>>('/settings'),
    staleTime: 60_000,
  });
  const configMaxLoops = (settings.data as Record<string, Record<string, unknown>> | undefined)?.agent?.maxLoops;
  const defaultMaxLoops = typeof configMaxLoops === 'number' ? configMaxLoops : 20;
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
    refetchInterval: run.running ? 4_000 : false,
  });
  const sessionTrace = useQuery({
    queryKey: ['chat-session-trace', sessionId],
    queryFn: () => getJson<SessionTraceResponse>(`/sessions/${sessionId}/trace`),
    enabled: Boolean(sessionId),
    refetchInterval: run.running ? 4_000 : false,
  });
  const sessionObservability = useQuery({
    queryKey: ['chat-session-observability', sessionId],
    queryFn: () => getJson<SessionObservability>(`/sessions/${sessionId}/observability`),
    enabled: Boolean(sessionId),
    refetchInterval: run.running ? 4_000 : false,
  });

  const advancedCount = useMemo(() => {
    return buildAdvancedCount({ systemPrompt, allowedTools, maxLoops, timeoutMs, toolRetryMaxAttempts, toolRetryBaseDelayMs, toolRetryMaxDelayMs, temperature, topP, maxTokens, presencePenalty, frequencyPenalty });
  }, [systemPrompt, allowedTools, maxLoops, timeoutMs, toolRetryMaxAttempts, toolRetryBaseDelayMs, toolRetryMaxDelayMs, temperature, topP, maxTokens, presencePenalty, frequencyPenalty]);

  const advancedState = useMemo((): ChatAdvancedSettingsState => ({
    systemPrompt, allowedTools, maxLoops, timeoutMs, toolRetryMaxAttempts, toolRetryBaseDelayMs, toolRetryMaxDelayMs, temperature, topP, maxTokens, presencePenalty, frequencyPenalty,
  }), [systemPrompt, allowedTools, maxLoops, timeoutMs, toolRetryMaxAttempts, toolRetryBaseDelayMs, toolRetryMaxDelayMs, temperature, topP, maxTokens, presencePenalty, frequencyPenalty]);

  function onAdvancedChange(patch: Partial<ChatAdvancedSettingsState>) {
    if (patch.systemPrompt !== undefined) setSystemPrompt(patch.systemPrompt);
    if (patch.allowedTools !== undefined) setAllowedTools(patch.allowedTools);
    if (patch.maxLoops !== undefined) setMaxLoops(patch.maxLoops);
    if (patch.timeoutMs !== undefined) setTimeoutMs(patch.timeoutMs);
    if (patch.toolRetryMaxAttempts !== undefined) setToolRetryMaxAttempts(patch.toolRetryMaxAttempts);
    if (patch.toolRetryBaseDelayMs !== undefined) setToolRetryBaseDelayMs(patch.toolRetryBaseDelayMs);
    if (patch.toolRetryMaxDelayMs !== undefined) setToolRetryMaxDelayMs(patch.toolRetryMaxDelayMs);
    if (patch.temperature !== undefined) setTemperature(patch.temperature);
    if (patch.topP !== undefined) setTopP(patch.topP);
    if (patch.maxTokens !== undefined) setMaxTokens(patch.maxTokens);
    if (patch.presencePenalty !== undefined) setPresencePenalty(patch.presencePenalty);
    if (patch.frequencyPenalty !== undefined) setFrequencyPenalty(patch.frequencyPenalty);
  }
  const sessionMetadata = sessionDetail.data?.metadata ?? {};

  // Live trace update during run
  useEffect(() => {
    if (!run.running) return;
    const trace = sessionTrace.data;
    if (!trace || !Array.isArray(trace.messages) || trace.messages.length === 0) return;
    const msgs = mapTraceToMessages(trace.messages, sessionId);
    mergeLiveToolCalls(msgs, run.liveToolCalls);
    run.setMessages(msgs);
  }, [sessionTrace.data, run.running, sessionId, run.liveVersion]);

  useEffect(() => { try { localStorage.setItem('los-workspace', workspaceRoot); } catch {} }, [workspaceRoot]);

  // Session selection
  useEffect(() => {
    if (run.running) return;
    if (!selectedSessionId || selectedSessionId === sessionId) return;
    setHookSessionId(selectedSessionId);
    setTaskRunId(null);
    run.historyLoadedForSession.current = null;
    run.setRows([{ id: crypto.randomUUID(), event: 'session.loading', message: `Loading session ${selectedSessionId}...`, level: 'normal' }]);
    run.setMessages([{ id: crypto.randomUUID(), role: 'system' as const, content: `Loading session ${selectedSessionId}...`, eventType: 'session.loading', toolCalls: [] }]);
  }, [selectedSessionId, sessionId, run.running]);

  // Session resume
  useEffect(() => {
    if (run.running) return;
    if (!sessionId || sessionId !== selectedSessionId) return;
    if (run.historyLoadedForSession.current === sessionId) return;
    const trace = sessionTrace.data;
    if (!trace || !Array.isArray(trace.messages) || trace.messages.length === 0) return;
    run.historyLoadedForSession.current = sessionId;
    const detail = sessionDetail.data;
    const msgs = detail?.messages ?? [];
    const turns = detail?.turns ?? [];
    run.setRows(buildHistoryRows(msgs as Array<Record<string, unknown>>, turns as Array<Record<string, unknown>>));
    run.setMessages(mapTraceToMessages(trace.messages, sessionId));
  }, [sessionDetail.data, sessionTrace.data, sessionId, selectedSessionId, run.running]);

  // Branch
  useEffect(() => {
    if (run.running || !branchFromSession) return;
    run.branchFromRef.current = branchFromSession;
    setHookSessionId(null);
    setTaskRunId(null);
    run.historyLoadedForSession.current = null;
    run.setRows([{ id: crypto.randomUUID(), event: 'session.branch', message: `Branching from ${branchFromSession}. Enter your prompt to start.`, level: 'ok' }]);
    run.setMessages([{ id: crypto.randomUUID(), role: 'system' as const, content: `Branching from ${branchFromSession}. Enter your prompt to start.`, eventType: 'session.branch', level: 'ok', toolCalls: [] }]);
    Promise.all([getJson<SessionDetail>(`/sessions/${branchFromSession}`), getJson<SessionTraceResponse>(`/sessions/${branchFromSession}/trace`)])
      .then(([detail, trace]) => {
        if (detail && Array.isArray(detail.messages) && detail.messages.length > 0) {
          const dmsgs = detail.messages as Array<Record<string, unknown>>;
          const dturns = Array.isArray(detail.turns) ? (detail.turns as Array<Record<string, unknown>>) : [];
          run.setRows(prev => run.branchFromRef.current ? buildHistoryRows(dmsgs, dturns) : prev);
          run.setMessages(prev => run.branchFromRef.current ? (trace?.messages ? mapTraceToMessages(trace.messages, sessionId) : prev) : prev);
        }
      }).catch(() => undefined);
  }, [branchFromSession, run.running]);

  // Todo context
  useEffect(() => {
    if (run.running || !activeTodoContext || activeTodoContext.id === boundTodoId) return;
    bindTodo(activeTodoContext);
    run.setPrompt(buildTodoPrompt(activeTodoContext));
    run.setRows([{ id: crypto.randomUUID(), event: 'todo.selected', message: activeTodoContext.title, meta: activeTodoContext.id, level: 'ok' }]);
    run.setMessages([{ id: crypto.randomUUID(), role: 'system' as const, content: activeTodoContext.title, meta: activeTodoContext.id, level: 'ok', toolCalls: [] }]);
  }, [activeTodoContext, boundTodoId, run.running, sessionId]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void run.handleSubmit(run.prompt);
  }

  function startNewChat() {
    if (run.running) return;
    if (hookSessionId || taskRunId) {
      if (!newChatConfirming) { setNewChatConfirming(true); return; }
      setNewChatConfirming(false);
    }
    startNewChatFromHook();
    run.startNewChat();
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
            <button className={`ghost-btn${newChatConfirming ? ' danger' : ''}`} type="button" disabled={run.running} onClick={startNewChat}>
              <MessageSquarePlus size={14} /> {newChatConfirming ? 'confirm new?' : 'new chat'}
            </button>
            <button className="ghost-btn" type="button" onClick={() => { run.setRows([]); run.setMessages([]); }}>
              <RefreshCcw size={14} /> clear
            </button>
            <button className="ghost-btn" type="button" onClick={() => setShowFiles(!showFiles)}>
              <Folder size={14} /> files
            </button>
          </div>
        </div>

        <div className="chat-context-bar">
          <ContextChip label="session" value={sessionId ?? 'new'} tone={sessionId ? 'ok' : undefined} />
          {activeTodoContext ? <ContextChip label="todo" value={activeTodoContext.id} tone="ok" /> : null}
          {runtimeKind !== 'los' ? (
            <ContextChip label="runtime" value={runtimeKind} tone="warn" />
          ) : (
            <>
              <ContextChip label="provider" value={provider || 'default'} />
              <ContextChip label="model" value={model || 'provider default'} />
            </>
          )}
          <ContextChip label="task" value={taskRunId ?? (run.running ? 'starting' : 'idle')} tone={run.running ? 'warn' : undefined} />
        </div>

        <ChatMessages messages={run.messages} debugMode={debugMode} onDebugModeChange={setDebugMode} running={run.running}>
          {run.contextNotifs.length > 0 && (
            <div className="context-notif-strip">
              {run.contextNotifs.map(cn => <ContextNotification key={cn.id} event={cn.event} data={cn.data} />)}
            </div>
          )}
          {run.cancelled && <CancelledBanner />}
          {run.approvalEvents.length > 0 && (
            <div className="approval-strip">
              {run.approvalEvents.map(ae => <ApprovalCard key={ae.id} event={ae} />)}
            </div>
          )}
          {run.rows.length === 0 ? <EmptyText text="No stream events yet." /> : run.rows.map(row => (
            <div className={`stream-row${row.event === '---' || row.event === 'history.end' ? ' stream-separator' : ''}`} data-level={row.level ?? 'normal'} key={row.id}>
              <span className="stream-event">{row.event}</span>
              <div><p>{row.message}</p>{row.meta ? <code>{row.meta}</code> : null}</div>
            </div>
          ))}
        </ChatMessages>

        <ChatComposer
          prompt={run.prompt} onPromptChange={run.setPrompt} onSubmit={handleSubmit}
          onCancel={run.requestCancel} running={run.running}
          provider={provider} onProviderChange={setProvider} providerOptions={providerOptions}
          model={model} onModelChange={setModel} modelRoutes={modelRoutes.data}
          toolMode={toolMode} onToolModeChange={setToolMode} runtimeKind={runtimeKind}
          onRuntimeKindChange={setRuntimeKind} workspaceRoot={workspaceRoot}
          onWorkspaceRootChange={setWorkspaceRoot} defaultWorkspace={defaultWorkspace}
          advancedState={advancedState} onAdvancedChange={onAdvancedChange} advancedCount={advancedCount}
        />
      </div>

      <aside className="panel inspector">
        <div className="panel-head compact">
          <h2>Run Evidence</h2>
          <Activity size={16} />
        </div>
        <div className="fact-list compact-facts">
          <Fact label="connection" value={run.connectionState === 'connected' ? 'WS live' : run.connectionState === 'reconnecting' ? 'reconnecting…' : run.connectionState === 'connecting' ? 'connecting…' : 'polling'} />
          <Fact label="session" value={sessionId ?? 'not started'} />
          <Fact label="task run" value={taskRunId ?? (run.running ? 'starting' : 'idle')} />
          <Fact label="last provider" value={metadataText(sessionMetadata.provider) ?? 'none'} />
          <Fact label="last model" value={metadataText(sessionMetadata.model) ?? 'none'} />
          <Fact label="settings" value={metadataText(JSON.stringify(sessionMetadata.modelSettings ?? {})) ?? '{}'} />
          <Fact label="tokens" value={String(sessionObservability.data?.totalUsage.totalTokens ?? 0)} />
        </div>
      </aside>

      <FilesPanel workspaceRoot={workspaceRoot} open={showFiles} onClose={() => setShowFiles(false)} />

      {run.showAbortConfirm && (
        <AbortConfirmation
          onConfirm={run.confirmCancel} onCancel={run.dismissCancel}
          elapsedMs={run.runStartRef.current ? Date.now() - run.runStartRef.current : undefined}
        />
      )}
    </section>
  );
}
