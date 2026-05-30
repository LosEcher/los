import { type FormEvent, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Database,
  RefreshCcw,
  Search,
  Send,
  Square,
  Trash2,
} from 'lucide-react';
import {
  deleteJson,
  getJson,
  postJson,
  streamChat,
  type MemoryResponse,
  type MemoryStats,
  type ProviderDiscovery,
  type ProviderModelsResponse,
  type SessionDetail,
  type SessionEventsResponse,
  type SessionObservability,
  type SessionSummary,
  type TaskRun,
  type ToolMode,
} from './api';
import {
  DataTable,
  Definition,
  EmptyText,
  Fact,
  Field,
  formatDate,
  formatTime,
  RefreshQueryButton,
  StatusPill,
} from './ui';

type StreamRow = {
  id: string;
  event: string;
  message: string;
  meta?: string;
  level?: 'normal' | 'ok' | 'warn' | 'error';
};

export function ChatPage({ onSessionSelect }: { onSessionSelect: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState('');
  const [provider, setProvider] = useState('');
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [toolMode, setToolMode] = useState<ToolMode>('project-write');
  const [maxLoops, setMaxLoops] = useState(8);
  const [timeoutMs, setTimeoutMs] = useState(120_000);
  const [running, setRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [taskRunId, setTaskRunId] = useState<string | null>(null);
  const [rows, setRows] = useState<StreamRow[]>([
    { id: 'ready', event: 'system', message: 'Ready for a bounded project task.', meta: 'project-write blocks shell execution' },
  ]);
  const abortRef = useRef<AbortController | null>(null);

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
        provider: provider.trim() || undefined,
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
        setRows(prev => [...prev, { id: crypto.randomUUID(), event: 'error', message: String((err as Error).message ?? err), level: 'error' }]);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
      await queryClient.invalidateQueries({ queryKey: ['sessions'] });
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
      await queryClient.invalidateQueries({ queryKey: ['memory'] });
    }
  }

  async function cancelRun() {
    if (taskRunId) {
      await postJson(`/tasks/${taskRunId}/cancel`, { reason: 'cancelled_from_web_console' }).catch(() => undefined);
    }
    abortRef.current?.abort();
    setRunning(false);
  }

  return (
    <section className="panel-grid chat-grid">
      <div className="panel main-panel">
        <div className="panel-head">
          <div>
            <h2>Live Run</h2>
            <p>Streamed from Gateway `/chat` with task and session evidence.</p>
          </div>
          <button className="ghost-btn" type="button" onClick={() => setRows([])}>
            <RefreshCcw size={14} /> clear
          </button>
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
          <textarea
            value={prompt}
            onChange={event => setPrompt(event.target.value)}
            placeholder="Ask los to inspect or prepare a bounded change..."
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
          <h2>Run Controls</h2>
        </div>
        <Field label="provider endpoint">
          <input value={provider} onChange={event => setProvider(event.target.value)} placeholder="default provider" />
        </Field>
        <Field label="workspace root">
          <input value={workspaceRoot} onChange={event => setWorkspaceRoot(event.target.value)} placeholder="default los repo" />
        </Field>
        <Field label="tool mode">
          <select value={toolMode} onChange={event => setToolMode(event.target.value as ToolMode)}>
            <option value="read-only">read-only</option>
            <option value="project-write">project-write</option>
            <option value="all">all</option>
          </select>
        </Field>
        <div className="two-col">
          <Field label="max loops">
            <input type="number" min={1} max={50} value={maxLoops} onChange={event => setMaxLoops(Number(event.target.value))} />
          </Field>
          <Field label="timeout ms">
            <input type="number" min={1000} step={1000} value={timeoutMs} onChange={event => setTimeoutMs(Number(event.target.value))} />
          </Field>
        </div>
        <div className="fact-list">
          <Fact label="session" value={sessionId ?? 'not started'} />
          <Fact label="task" value={taskRunId ?? 'not started'} />
          <Fact label="shell" value={toolMode === 'all' ? 'allowed by mode' : 'blocked'} />
        </div>
      </aside>
    </section>
  );
}

export function SessionsPage({ selectedSessionId, onSelectSession }: { selectedSessionId: string | null; onSelectSession: (id: string) => void }) {
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => getJson<SessionSummary[]>('/sessions'),
    refetchInterval: 12_000,
  });

  return (
    <section className="panel-grid detail-grid">
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Sessions</h2>
            <p>Read-only persisted run list.</p>
          </div>
          <RefreshQueryButton queryKey={['sessions']} />
        </div>
        <DataTable
          loading={sessions.isLoading}
          empty="No sessions found."
          rows={sessions.data ?? []}
          renderRow={session => (
            <button
              type="button"
              className="record-row"
              data-active={selectedSessionId === session.id}
              onClick={() => onSelectSession(session.id)}
            >
              <span className="row-title">{session.id}</span>
              <span>{formatDate(session.updatedAt)}</span>
              <span>{String(session.metadata.provider ?? 'provider?')}</span>
              <span>{String(session.metadata.toolMode ?? 'mode?')}</span>
            </button>
          )}
        />
      </div>
      <SessionInspector sessionId={selectedSessionId} />
    </section>
  );
}

function SessionInspector({ sessionId }: { sessionId: string | null }) {
  const detail = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => getJson<SessionDetail>(`/sessions/${sessionId}`),
    enabled: Boolean(sessionId),
  });
  const events = useQuery({
    queryKey: ['session-events', sessionId],
    queryFn: () => getJson<SessionEventsResponse>(`/sessions/${sessionId}/events?limit=300`),
    enabled: Boolean(sessionId),
  });
  const observability = useQuery({
    queryKey: ['session-observability', sessionId],
    queryFn: () => getJson<SessionObservability>(`/sessions/${sessionId}/observability`),
    enabled: Boolean(sessionId),
  });

  if (!sessionId) {
    return <div className="panel inspector"><EmptyText text="Select a session to inspect events and observability." /></div>;
  }

  return (
    <aside className="panel inspector">
      <div className="panel-head compact">
        <h2>Session Detail</h2>
        <span className="mono-chip">{sessionId}</span>
      </div>
      {detail.isLoading ? <EmptyText text="Loading session..." /> : null}
      {observability.data ? (
        <div className="fact-list">
          <Fact label="events" value={String(observability.data.eventCount)} />
          <Fact label="turns" value={String(observability.data.turnCount)} />
          <Fact label="tokens" value={String(observability.data.totalUsage.totalTokens)} />
          <Fact label="tools" value={observability.data.tools.names.join(', ') || observability.data.tools.status} />
          <Fact label="models" value={observability.data.models.names.join(', ') || observability.data.models.status} />
        </div>
      ) : null}
      <div className="event-timeline">
        {(events.data?.events ?? []).slice(-80).map(event => (
          <div className="event-line" key={event.id}>
            <span>{formatTime(event.createdAt)}</span>
            <strong>{event.type}</strong>
            <em>{event.toolName ?? event.model ?? event.source}</em>
          </div>
        ))}
      </div>
    </aside>
  );
}

export function TasksPage({ onSelectSession }: { onSelectSession: (id: string) => void }) {
  const queryClient = useQueryClient();
  const tasks = useQuery({
    queryKey: ['tasks'],
    queryFn: () => getJson<TaskRun[]>('/tasks'),
    refetchInterval: 8_000,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => postJson(`/tasks/${id}/cancel`, { reason: 'cancelled_from_tasks_page' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tasks'] }),
  });

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Tasks</h2>
          <p>Scheduler records above chat sessions. Cancel is available only for active tasks.</p>
        </div>
        <RefreshQueryButton queryKey={['tasks']} />
      </div>
      <DataTable
        loading={tasks.isLoading}
        empty="No tasks yet."
        rows={tasks.data ?? []}
        renderRow={task => (
          <div className="record-row task-row">
            <button type="button" className="link-cell" onClick={() => onSelectSession(task.sessionId)}>
              {task.id}
            </button>
            <span className={`status-text ${task.status}`}>{task.status}</span>
            <span>{task.toolMode}</span>
            <span>{task.provider ?? 'default'}</span>
            <span>{formatDate(task.updatedAt)}</span>
            <button className="tiny-btn" type="button" disabled={!['queued', 'running'].includes(task.status) || cancel.isPending} onClick={() => cancel.mutate(task.id)}>
              cancel
            </button>
          </div>
        )}
      />
    </section>
  );
}

export function MemoryPage() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const memory = useQuery({
    queryKey: ['memory', query],
    queryFn: () => getJson<MemoryResponse>(`/memory?limit=80&q=${encodeURIComponent(query)}`),
  });
  const stats = useQuery({
    queryKey: ['memory-stats'],
    queryFn: () => getJson<MemoryStats>('/memory/stats'),
  });
  const add = useMutation({
    mutationFn: () => postJson('/memory', {
      title,
      summary,
      kind: 'note',
      tags: ['web-console'],
      source: 'user',
    }),
    onSuccess: async () => {
      setTitle('');
      setSummary('');
      await queryClient.invalidateQueries({ queryKey: ['memory'] });
      await queryClient.invalidateQueries({ queryKey: ['memory-stats'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => deleteJson(`/memory/${id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['memory'] });
      await queryClient.invalidateQueries({ queryKey: ['memory-stats'] });
    },
  });

  return (
    <section className="panel-grid memory-grid">
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Memory</h2>
            <p>Read/write observations with source and session linkage.</p>
          </div>
          <div className="search-box">
            <Search size={14} />
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="search memory" />
          </div>
        </div>
        <div className="memory-list">
          {memory.isLoading ? <EmptyText text="Loading memory..." /> : null}
          {(memory.data?.results ?? []).map(obs => (
            <article className="memory-row" key={obs.id}>
              <div>
                <h3>{obs.title}</h3>
                <p>{obs.summary || 'No summary'}</p>
                <span>{obs.kind} · {obs.source} · {formatDate(obs.updatedAt)}</span>
              </div>
              <button className="icon-btn danger" type="button" onClick={() => remove.mutate(obs.id)} title="delete memory">
                <Trash2 size={14} />
              </button>
            </article>
          ))}
        </div>
      </div>
      <aside className="panel inspector">
        <div className="panel-head compact">
          <h2>Add Observation</h2>
        </div>
        <form className="stack-form" onSubmit={(event) => { event.preventDefault(); if (title.trim()) add.mutate(); }}>
          <Field label="title">
            <input value={title} onChange={event => setTitle(event.target.value)} placeholder="short memory title" />
          </Field>
          <Field label="summary">
            <textarea value={summary} onChange={event => setSummary(event.target.value)} rows={5} placeholder="what should future runs know?" />
          </Field>
          <button className="primary-btn" type="submit" disabled={!title.trim() || add.isPending}>
            <Database size={14} /> save
          </button>
        </form>
        <div className="fact-list">
          <Fact label="total" value={String(stats.data?.totalObservations ?? 0)} />
          <Fact label="kinds" value={Object.keys(stats.data?.byKind ?? {}).join(', ') || 'none'} />
          <Fact label="sources" value={Object.keys(stats.data?.bySource ?? {}).join(', ') || 'none'} />
        </div>
      </aside>
    </section>
  );
}

export function ProvidersPage() {
  const onboarding = useQuery({
    queryKey: ['onboarding'],
    queryFn: () => getJson<ProviderDiscovery>('/onboarding'),
    staleTime: 20_000,
  });
  const modelRoutes = useQuery({
    queryKey: ['provider-models'],
    queryFn: () => getJson<ProviderModelsResponse>('/providers/models'),
    staleTime: 20_000,
  });
  const providers = onboarding.data?.providers ?? [];
  const tools = onboarding.data?.tools ?? [];
  const routes = modelRoutes.data?.providers ?? [];

  return (
    <section className="panel-grid provider-grid">
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Provider Endpoints</h2>
            <p>Read-only discovery surface. Provider lifecycle edits are deferred until stable APIs exist.</p>
          </div>
          <StatusPill status="partial" />
        </div>
        <DataTable
          loading={onboarding.isLoading}
          empty="No provider endpoints discovered."
          rows={providers}
          renderRow={(provider, index) => (
            <div className="record-row">
              <span className="row-title">{String(provider.name ?? provider.provider ?? `provider-${index + 1}`)}</span>
              <span>{String(provider.source ?? 'source?')}</span>
              <span>{String(provider.defaultModel ?? provider.model ?? 'model?')}</span>
              <span>{String(provider.available ?? provider.importable ?? 'state?')}</span>
            </div>
          )}
        />
        <div className="section-divider" />
        <div className="panel-head compact">
          <h2>Effective Model Routes</h2>
          <StatusPill status="live" />
        </div>
        <DataTable
          loading={modelRoutes.isLoading}
          empty="No callable model routes found."
          rows={routes}
          renderRow={(route) => (
            <div className="record-row route-row">
              <span className="row-title">{route.provider}</span>
              <span>{route.baseUrl ?? 'baseUrl?'}</span>
              <span>{route.model ?? 'model?'}</span>
              <span>{route.ok ? `${route.count ?? route.models.length} models` : route.error ?? 'unavailable'}</span>
            </div>
          )}
        />
      </div>
      <aside className="panel inspector">
        <div className="panel-head compact"><h2>Discovery Tools</h2></div>
        <div className="fact-list">
          <Fact label="providers" value={String(providers.length)} />
          <Fact label="routes" value={String(routes.length)} />
          <Fact label="tools" value={String(tools.length)} />
          <Fact label="status" value={onboarding.data?.summary ?? 'not loaded'} />
        </div>
        <div className="definition-list">
          <Definition term="provider endpoint" text="Callable model backend or route." />
          <Definition term="provider account" text="Credential-bearing identity behind an endpoint." />
          <Definition term="provider model" text="Concrete model identifier exposed by the endpoint." />
        </div>
      </aside>
    </section>
  );
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
      meta: String(data.taskRunId ?? ''),
      level: String(data.status ?? '').includes('succeeded') ? 'ok' : 'normal',
    };
  }
  return {
    id: crypto.randomUUID(),
    event,
    message: JSON.stringify(data),
  };
}
