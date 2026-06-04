import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Folder,
  MessageSquarePlus,
  RefreshCcw,
  Send,
  SlidersHorizontal,
  Square,
  Wrench,
} from 'lucide-react';
import {
  getJson,
  postJson,
  streamChat,
  type ModelSettings,
  type ProviderDiscovery,
  type ProviderModelsResponse,
  type SessionDetail,
  type SessionEvent,
  type SessionEventsResponse,
  type SessionObservability,
  type ToolMode,
} from './api';
import {
  EmptyText,
  Fact,
  formatDate,
  formatTime,
} from './ui';

type StreamRow = {
  id: string;
  event: string;
  message: string;
  meta?: string;
  level?: 'normal' | 'ok' | 'warn' | 'error';
};

type ProviderOption = {
  id: string;
  label: string;
  source: string;
  defaultModel: string;
  state: string;
  hasApiKey?: boolean;
};

export function ChatPage({
  selectedSessionId,
  onSessionSelect,
}: {
  selectedSessionId: string | null;
  onSessionSelect: (id: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState('');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [workspaceRoot, setWorkspaceRoot] = useState(() => {
    try { return localStorage.getItem('los-workspace') ?? ''; } catch { return ''; }
  });
  const [toolMode, setToolMode] = useState<ToolMode>('project-write');
  const [maxLoops, setMaxLoops] = useState(8);
  const [timeoutMs, setTimeoutMs] = useState(120_000);
  const [temperature, setTemperature] = useState('');
  const [topP, setTopP] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [presencePenalty, setPresencePenalty] = useState('');
  const [frequencyPenalty, setFrequencyPenalty] = useState('');
  const [running, setRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [taskRunId, setTaskRunId] = useState<string | null>(null);
  const [rows, setRows] = useState<StreamRow[]>([
    {
      id: 'ready',
      event: 'system',
      message: 'Ready for a bounded project task.',
      meta: 'project-write blocks shell execution',
    },
  ]);
  const abortRef = useRef<AbortController | null>(null);

  const onboarding = useQuery({
    queryKey: ['onboarding'],
    queryFn: () => getJson<ProviderDiscovery>('/onboarding'),
    staleTime: 20_000,
  });
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
  const sessionEvents = useQuery({
    queryKey: ['chat-session-events', sessionId],
    queryFn: () => getJson<SessionEventsResponse>(`/sessions/${sessionId}/events?limit=80`),
    enabled: Boolean(sessionId),
    refetchInterval: running ? 4_000 : false,
  });
  // Live event push via EventSource
  useEffect(() => {
    if (!sessionId || !running) return;
    const es = new EventSource(`/sessions/${sessionId}/events/live`);
    const onSessionEvent = (msg: MessageEvent<string>) => {
      try {
        const event = JSON.parse(msg.data) as SessionEvent;
        queryClient.setQueryData<SessionEventsResponse>(
          ['chat-session-events', sessionId],
          (prev) => appendLiveSessionEvent(prev, sessionId, event),
        );
        void queryClient.invalidateQueries({ queryKey: ['chat-session-observability', sessionId] });
      } catch {}
    };
    es.addEventListener('session_event', onSessionEvent);
    es.onerror = () => {
      es.close();
      void queryClient.invalidateQueries({ queryKey: ['chat-session-events', sessionId] });
    };
    return () => {
      es.removeEventListener('session_event', onSessionEvent);
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
  const selectedRoute = useMemo(() => {
    const routes = modelRoutes.data?.providers ?? [];
    return routes.find(route => route.provider === provider) ?? routes[0] ?? null;
  }, [modelRoutes.data, provider]);
  const modelOptions = useMemo(() => {
    const ids = new Set<string>();
    if (selectedRoute?.model) ids.add(selectedRoute.model);
    for (const item of selectedRoute?.models ?? []) {
      if (item.id) ids.add(item.id);
    }
    return [...ids];
  }, [selectedRoute]);
  const sessionMetadata = sessionDetail.data?.metadata ?? {};
  const recentEvents = sessionEvents.data?.events.slice(-8) ?? [];

  // Persist workspaceRoot to localStorage
  useEffect(() => {
    try { localStorage.setItem('los-workspace', workspaceRoot); } catch {}
  }, [workspaceRoot]);

  useEffect(() => {
    if (running) return;
    if (!selectedSessionId || selectedSessionId === sessionId) return;
    setSessionId(selectedSessionId);
    setTaskRunId(null);
    setRows([{
      id: crypto.randomUUID(),
      event: 'session.selected',
      message: `Ready to continue ${selectedSessionId}.`,
      meta: 'next send will include this sessionId',
      level: 'ok',
    }]);
  }, [selectedSessionId, sessionId, running]);

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
    setRows([{ id: crypto.randomUUID(), event: 'user', message: text }]);

    try {
      await streamChat({
        prompt: text,
        sessionId: sessionId ?? undefined,
        provider: provider.trim() || undefined,
        model: model.trim() || undefined,
        modelSettings: buildModelSettingsPayload({
          temperature,
          topP,
          maxTokens,
          presencePenalty,
          frequencyPenalty,
        }),
        workspaceRoot: workspaceRoot.trim() || undefined,
        toolMode,
        maxLoops,
        timeoutMs,
      }, controller.signal, ({ event, data }) => {
        if (event === 'session' && typeof data.sessionId === 'string') {
          setSessionId(data.sessionId);
          onSessionSelect(data.sessionId);
        }
        if (typeof data.taskRunId === 'string') setTaskRunId(data.taskRunId);
        setRows(prev => [...prev, streamRow(event, data)]);
      });
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setRows(prev => [...prev, {
          id: crypto.randomUUID(),
          event: 'error',
          message: String((err as Error).message ?? err),
          level: 'error',
        }]);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
      await queryClient.invalidateQueries({ queryKey: ['sessions'] });
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
      await queryClient.invalidateQueries({ queryKey: ['memory'] });
      await queryClient.invalidateQueries({ queryKey: ['chat-session', sessionId] });
      await queryClient.invalidateQueries({ queryKey: ['chat-session-events', sessionId] });
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

  function startNewChat() {
    if (running) return;
    setSessionId(null);
    setTaskRunId(null);
    setRows([{
      id: crypto.randomUUID(),
      event: 'session.new',
      message: 'New chat is ready.',
      meta: 'next send will create a new session',
      level: 'ok',
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
            <button className="ghost-btn" type="button" disabled={running} onClick={startNewChat}>
              <MessageSquarePlus size={14} /> new chat
            </button>
            <button className="ghost-btn" type="button" onClick={() => setRows([])}>
              <RefreshCcw size={14} /> clear
            </button>
          </div>
        </div>

        <div className="chat-context-bar">
          <ContextChip label="session" value={sessionId ?? 'new'} tone={sessionId ? 'ok' : undefined} />
          <ContextChip label="provider" value={provider || 'default'} />
          <ContextChip label="model" value={model || 'provider default'} />
          <ContextChip label="task" value={taskRunId ?? (running ? 'starting' : 'idle')} tone={running ? 'warn' : undefined} />
        </div>

        <div className="stream-list">
          {rows.length === 0 ? <EmptyText text="No stream events yet." /> : rows.map(row => (
            <div className="stream-row" data-level={row.level ?? 'normal'} key={row.id}>
              <span className="stream-event">{row.event}</span>
              <div>
                <p>{row.message}</p>
                {row.meta ? <code>{row.meta}</code> : null}
              </div>
            </div>
          ))}
        </div>

        <form className="composer" onSubmit={handleSubmit}>
          <div className="composer-toolbar" aria-label="run choices">
            <span
              className={`route-dot ${selectedRoute?.ok ? 'ok' : 'partial'}`}
              title={selectedRoute?.baseUrl ?? selectedRoute?.error ?? onboarding.data?.summary ?? 'discovery pending'}
            />
            <RunField label="provider" title="Provider endpoint for this send">
              {providerOptions.length > 0 ? (
                <select value={provider} onChange={event => { setProvider(event.target.value); setModel(''); }}>
                  {providerOptions.map(option => (
                    <option value={option.id} key={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input value={provider} onChange={event => { setProvider(event.target.value); setModel(''); }} placeholder="provider id" />
              )}
            </RunField>
            <RunField label="model" title="Model for this send">
              {modelOptions.length > 0 ? (
                <select value={model} onChange={event => setModel(event.target.value)}>
                  {modelOptions.map(option => <option value={option} key={option}>{option}</option>)}
                </select>
              ) : (
                <input value={model} onChange={event => setModel(event.target.value)} placeholder={selectedRoute?.model ?? 'provider default'} />
              )}
            </RunField>
            <RunField label="tools / skills" title="Tool and skill access for this send">
              <Wrench size={13} />
              <select value={toolMode} onChange={event => setToolMode(event.target.value as ToolMode)}>
                <option value="read-only">off / read-only</option>
                <option value="project-write">project tools</option>
                <option value="all">all tools</option>
              </select>
            </RunField>
            <RunField label="execution dir" title={`Execution directory. Default: ${defaultWorkspace || 'loading...'}`}>
              <Folder size={13} />
              <input
                list="workspace-suggestions"
                value={workspaceRoot}
                onChange={event => setWorkspaceRoot(event.target.value)}
                placeholder={defaultWorkspace || 'cwd'}
                style={{ width: workspaceRoot ? 140 : 100 }}
              />
              <datalist id="workspace-suggestions">
                {defaultWorkspace && <option value={defaultWorkspace} />}
                {defaultWorkspace && <option value={defaultWorkspace.replace(/\/[^/]+$/, '')} />}
              </datalist>
              {workspaceRoot && workspaceRoot !== defaultWorkspace && (
                <button type="button" className="ghost-btn" title="Reset to default workspace"
                  style={{ minHeight: 24, padding: '0 6px', fontSize: 12 }}
                  onClick={() => setWorkspaceRoot('')}>
                  ↺ default
                </button>
              )}
            </RunField>
            <details className="composer-advanced">
              <summary title="Advanced request settings">
                <SlidersHorizontal size={14} />
              </summary>
              <div className="composer-advanced-panel">
                <RunField label="max loops" title="Maximum agent loops" variant="panel">
                  <input type="number" min={1} max={50} value={maxLoops} onChange={event => setMaxLoops(Number(event.target.value))} />
                </RunField>
                <RunField label="timeout ms" title="Request timeout in milliseconds" variant="panel">
                  <input type="number" min={1000} step={1000} value={timeoutMs} onChange={event => setTimeoutMs(Number(event.target.value))} />
                </RunField>
                <RunField label="temperature" title="Temperature" variant="panel">
                  <input inputMode="decimal" value={temperature} onChange={event => setTemperature(event.target.value)} placeholder="provider default" />
                </RunField>
                <RunField label="top p" title="Top P" variant="panel">
                  <input inputMode="decimal" value={topP} onChange={event => setTopP(event.target.value)} placeholder="provider default" />
                </RunField>
                <RunField label="max tokens" title="Maximum output tokens" variant="panel">
                  <input inputMode="numeric" value={maxTokens} onChange={event => setMaxTokens(event.target.value)} placeholder="provider default" />
                </RunField>
                <RunField label="presence penalty" title="Presence penalty" variant="panel">
                  <input inputMode="decimal" value={presencePenalty} onChange={event => setPresencePenalty(event.target.value)} placeholder="0" />
                </RunField>
                <RunField label="frequency penalty" title="Frequency penalty" variant="panel">
                  <input inputMode="decimal" value={frequencyPenalty} onChange={event => setFrequencyPenalty(event.target.value)} placeholder="0" />
                </RunField>
              </div>
            </details>
          </div>
          <textarea
            value={prompt}
            onChange={event => setPrompt(event.target.value)}
            placeholder={sessionId ? 'Continue this session with the next task...' : 'Ask los to inspect or prepare a bounded change...'}
            rows={3}
          />
          <div className="composer-actions">
            <button className="primary-btn" type="submit" disabled={running || !prompt.trim()}>
              <Send size={15} /> send
            </button>
            <button className="ghost-btn" type="button" disabled={!running} onClick={cancelRun}>
              <Square size={14} /> cancel
            </button>
          </div>
        </form>
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

        <div className="mini-timeline">
          <div className="mini-timeline-head">
            <strong>Recent Events</strong>
            <span>{sessionId ? formatDate(sessionDetail.data?.updatedAt) : 'no session'}</span>
          </div>
          {recentEvents.length === 0 ? (
            <EmptyText text={sessionId ? 'No ledger events loaded.' : 'Select or start a session.'} />
          ) : recentEvents.map(event => (
            <div className="mini-event" key={event.id}>
              <span>{formatTime(event.createdAt)}</span>
              <strong>{event.type}</strong>
              <em>{event.toolName ?? event.model ?? event.source}</em>
            </div>
          ))}
        </div>
      </aside>
    </section>
  );
}

function RunField({
  label,
  title,
  variant = 'toolbar',
  children,
}: {
  label: string;
  title: string;
  variant?: 'toolbar' | 'panel';
  children: ReactNode;
}) {
  return (
    <label className={`run-field ${variant === 'panel' ? 'panel-field' : ''}`} title={title}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function ContextChip({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' }) {
  return (
    <div className={`context-chip ${tone ?? ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function buildProviderOptions(discovery?: ProviderDiscovery, routes?: ProviderModelsResponse): ProviderOption[] {
  const byId = new Map<string, ProviderOption>();
  const order: string[] = [];
  const remember = (option: ProviderOption) => {
    if (!byId.has(option.id)) order.push(option.id);
    byId.set(option.id, option);
  };

  for (const route of routes?.providers ?? []) {
    remember({
      id: route.provider,
      label: route.provider,
      source: route.baseUrl ?? 'model route',
      defaultModel: route.model ?? '',
      state: route.ok ? 'ok' : route.error ?? 'unavailable',
      hasApiKey: route.hasApiKey,
    });
  }

  for (const [index, provider] of (discovery?.providers ?? []).entries()) {
    const id = metadataText(provider.provider) ?? metadataText(provider.name) ?? `provider-${index + 1}`;
    const previous = byId.get(id);
    remember({
      id,
      label: metadataText(provider.name) ?? id,
      source: metadataText(provider.source) ?? previous?.source ?? 'discovery',
      defaultModel: metadataText(provider.defaultModel) ?? metadataText(provider.model) ?? previous?.defaultModel ?? '',
      state: metadataText(provider.available) ?? metadataText(provider.importable) ?? previous?.state ?? 'discovered',
      hasApiKey: (provider.hasApiKey as boolean | undefined) ?? previous?.hasApiKey,
    });
  }

  return order.map(id => byId.get(id)!).filter(Boolean);
}

function metadataText(value: unknown): string | null {
  if (typeof value === 'string') {
    const text = value.trim();
    return text || null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function buildModelSettingsPayload(input: Record<keyof ModelSettings, string>): ModelSettings | undefined {
  const settings: ModelSettings = {
    temperature: parseOptionalNumber(input.temperature),
    topP: parseOptionalNumber(input.topP),
    maxTokens: parseOptionalInteger(input.maxTokens),
    presencePenalty: parseOptionalNumber(input.presencePenalty),
    frequencyPenalty: parseOptionalNumber(input.frequencyPenalty),
  };
  return Object.values(settings).some(value => value !== undefined) ? settings : undefined;
}

function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : undefined;
}

function parseOptionalInteger(value: string): number | undefined {
  const number = parseOptionalNumber(value);
  return number === undefined ? undefined : Math.floor(number);
}

function appendLiveSessionEvent(
  prev: SessionEventsResponse | undefined,
  sessionId: string,
  event: SessionEvent,
): SessionEventsResponse {
  if (!prev) return { sessionId, count: 1, events: [event] };

  const existingIndex = prev.events.findIndex(item => item.id === event.id);
  const events = existingIndex >= 0
    ? prev.events.map(item => item.id === event.id ? event : item)
    : [...prev.events, event];

  events.sort((a, b) => a.id - b.id);
  return {
    ...prev,
    events: events.slice(-200),
    count: existingIndex >= 0 ? prev.count : prev.count + 1,
  };
}

function streamRow(event: string, data: Record<string, unknown>): StreamRow {
  if (event === 'done') {
    return {
      id: crypto.randomUUID(),
      event,
      message: typeof data.text === 'string' ? data.text : 'Run completed.',
      meta: data.sessionId ? `session ${data.sessionId}` : undefined,
      level: 'ok',
    };
  }
  if (event === 'error') {
    return {
      id: crypto.randomUUID(),
      event,
      message: String(data.message ?? 'stream error'),
      level: 'error',
    };
  }
  if (event === 'session.resumed') {
    return {
      id: crypto.randomUUID(),
      event,
      message: `Resumed ${String(data.sessionId ?? 'session')}.`,
      meta: data.resumeLastTaskRunId ? `last task ${String(data.resumeLastTaskRunId)}` : undefined,
      level: 'ok',
    };
  }
  if (event === 'session.resume_state') {
    return {
      id: crypto.randomUUID(),
      event,
      message: 'Loaded session resume state.',
      meta: JSON.stringify(data),
      level: 'normal',
    };
  }
  if (event === 'model.delta') {
    return {
      id: crypto.randomUUID(),
      event,
      message: String(data.text ?? data.delta ?? ''),
      meta: [data.provider, data.model].filter(Boolean).join(' / '),
    };
  }
  if (event === 'turn') {
    return {
      id: crypto.randomUUID(),
      event,
      message: String(data.text ?? 'model turn'),
      meta: `loop ${String(data.loopCount ?? '?')} · tools ${Array.isArray(data.toolNames) ? data.toolNames.join(', ') || 'none' : '?'}`,
    };
  }
  if (event === 'tool_call') {
    return {
      id: crypto.randomUUID(),
      event,
      message: String(data.tool ?? 'tool call'),
      meta: String(data.args ?? ''),
      level: 'warn',
    };
  }
  if (event === 'task') {
    return {
      id: crypto.randomUUID(),
      event,
      message: String(data.type ?? data.status ?? 'task event'),
      meta: [data.taskRunId, data.nodeId].filter(Boolean).join(' · '),
      level: String(data.status ?? '').includes('succeeded') ? 'ok' : 'normal',
    };
  }
  return {
    id: crypto.randomUUID(),
    event,
    message: JSON.stringify(data),
  };
}
