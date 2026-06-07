import { useState, useMemo, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  Copy,
  Database,
  FileText,
  GitGraph,
  Layers,
  RotateCcw,
  Search,
  Send,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  deleteJson,
  getJson,
  patchJson,
  postJson,
  type AgentTaskGraph,
  type AgentTaskGraphCompletion,
  type MemoryObservation,
  type MemoryResponse,
  type MemoryStats,
  type ProviderDiscovery,
  type ProviderDiscoveryProvider,
  type ProviderModelsResponse,
  type ProviderReadiness,
  type RunSpec,
  type SessionDetail,
  type SessionEventsResponse,
  type SessionObservability,
  type SessionSummary,
  type TaskRun,
  type TodoItem,
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

export function SessionsPage({
  selectedSessionId,
  onSelectSession,
  onContinueSession,
  onBranchSession,
  onSelectTodo,
}: {
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
  onContinueSession: (id: string) => void;
  onBranchSession: (id: string) => void;
  onSelectTodo: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => getJson<SessionSummary[]>('/sessions'),
    refetchInterval: 12_000,
  });

  async function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportMessage(null);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const res = await postJson<{ ok?: boolean; error?: string; id?: string }>('/sessions/import', data);
      if (res.ok) {
        setImportMessage(`Imported ${res.id ?? 'session'}`);
        void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      } else {
        setImportMessage(res.error ?? 'Import failed');
      }
    } catch (err: any) {
      setImportMessage(err?.message ?? 'Import failed');
    } finally {
      setImporting(false);
      event.target.value = '';
    }
  }

  const sessionList = sessions.data ?? [];

  const { providers, models } = useMemo(() => {
    const p = new Set<string>();
    const m = new Set<string>();
    for (const s of sessionList) {
      const prov = metadataText(s.metadata.provider);
      const mod = metadataText(s.metadata.model);
      if (prov) p.add(prov);
      if (mod) m.add(mod);
    }
    return { providers: [...p].sort(), models: [...m].sort() };
  }, [sessionList]);

  const filtered = sessionList.filter(session => {
    if (search.trim()) {
      const q = search.toLowerCase();
      if (!session.id.toLowerCase().includes(q) &&
          !(metadataText(session.metadata.provider) ?? '').toLowerCase().includes(q) &&
          !(metadataText(session.metadata.model) ?? '').toLowerCase().includes(q)) {
        return false;
      }
    }
    if (providerFilter && (metadataText(session.metadata.provider) ?? '') !== providerFilter) return false;
    if (modelFilter && (metadataText(session.metadata.model) ?? '') !== modelFilter) return false;
    return true;
  });

  return (
    <section className="panel-grid detail-grid">
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Sessions</h2>
            <p>Read-only persisted run list.</p>
          </div>
          <div className="toolbar">
            <div className="search-box">
              <Search size={14} />
              <input value={search} onChange={event => setSearch(event.target.value)} placeholder="filter sessions" />
            </div>
            {providers.length > 1 ? (
              <select className="filter-select" value={providerFilter} onChange={event => setProviderFilter(event.target.value)} title="Filter by provider">
                <option value="">all providers</option>
                {providers.map(p => <option value={p} key={p}>{p}</option>)}
              </select>
            ) : null}
            {models.length > 1 ? (
              <select className="filter-select" value={modelFilter} onChange={event => setModelFilter(event.target.value)} title="Filter by model">
                <option value="">all models</option>
                {models.map(m => <option value={m} key={m}>{m}</option>)}
              </select>
            ) : null}
            <label className="ghost-btn" title="Import session from JSON file">
              <input type="file" accept=".json" style={{ display: 'none' }} onChange={handleImportFile} disabled={importing} />
              <Upload size={14} /> {importing ? 'importing...' : 'import'}
            </label>
            <RefreshQueryButton queryKey={['sessions']} />
            {importMessage ? <span className="mono-chip">{importMessage}</span> : null}
          </div>
        </div>
        <DataTable
          loading={sessions.isLoading}
          empty="No sessions found."
          rows={filtered}
          renderRow={session => {
            const branchFrom = metadataText(session.metadata.branchFrom);
            return (
            <button
              type="button"
              className="record-row session-row"
              data-active={selectedSessionId === session.id}
              onClick={() => onSelectSession(session.id)}
            >
              <span className="row-title">
                {branchFrom ? <span title={`branched from ${branchFrom}`}><GitGraph size={13} /></span> : null}
                {session.id}
              </span>
              <span>{formatDate(session.updatedAt)}</span>
              <span>{metadataText(session.metadata.provider) ?? 'provider?'}</span>
              <span>{metadataText(session.metadata.model) ?? 'model?'}</span>
              <span>{metadataText(session.metadata.toolMode) ?? 'mode?'}</span>
            </button>
            );
          }}
        />
      </div>
      <SessionInspector sessionId={selectedSessionId} onContinueSession={onContinueSession} onBranchSession={onBranchSession} onSelectTodo={onSelectTodo} />
    </section>
  );
}

function SessionInspector({
  sessionId,
  onContinueSession,
  onBranchSession,
  onSelectTodo,
}: {
  sessionId: string | null;
  onContinueSession: (id: string) => void;
  onBranchSession: (id: string) => void;
  onSelectTodo: (id: string) => void;
}) {
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
  const relatedTodos = useQuery({
    queryKey: ['session-related-todos', sessionId, detail.data?.metadata],
    queryFn: async () => {
      const urls = buildRelatedTodoUrls(sessionId, detail.data?.metadata ?? {});
      const batches = await Promise.all(urls.map(url => getJson<TodoItem[]>(url)));
      return dedupeTodos(batches.flat());
    },
    enabled: Boolean(sessionId && detail.data),
  });
  const verification = useQuery({
    queryKey: ['session-verification', sessionId],
    queryFn: () => getJson<{ count: number; records: Array<{ id: string; checkName: string; status: string; outputSummary?: string }> }>(`/sessions/${sessionId}/verification`),
    enabled: Boolean(sessionId),
  });

  if (!sessionId) {
    return <div className="panel inspector"><EmptyText text="Select a session to inspect events and observability." /></div>;
  }

  return (
    <aside className="panel inspector">
      <div className="panel-head compact">
        <h2>Session Detail</h2>
        <div className="toolbar">
          <button className="ghost-btn" type="button" onClick={() => onContinueSession(sessionId)}>
            <Send size={14} /> continue
          </button>
          <button className="ghost-btn" type="button" onClick={() => onBranchSession(sessionId)} title="Branch from this session into a new one">
            <GitGraph size={14} /> branch
          </button>
          <button className="ghost-btn" type="button" onClick={() => exportSession(sessionId)}>
            <Copy size={14} /> export
          </button>
          <DeleteSessionButton sessionId={sessionId} />
        </div>
      </div>
      <span className="mono-chip">{sessionId}</span>
      {detail.isLoading ? <EmptyText text="Loading session..." /> : null}
      {detail.data ? (
        <div className="fact-list compact-facts">
          <Fact label="provider" value={metadataText(detail.data.metadata.provider) ?? 'default'} />
          <Fact label="model" value={metadataText(detail.data.metadata.model) ?? 'default'} />
          <Fact label="tool mode" value={metadataText(detail.data.metadata.toolMode) ?? 'unknown'} />
          <Fact label="workspace" value={metadataText(detail.data.metadata.workspaceRoot) ?? 'default'} />
          <Fact label="task" value={metadataText(detail.data.metadata.taskRunId) ?? 'none'} />
          {metadataText(detail.data.metadata.branchFrom) ? (
            <Fact label="branch from" value={`${metadataText(detail.data.metadata.branchFrom)}${metadataText(detail.data.metadata.branchAtTurn) ? ` @ turn ${metadataText(detail.data.metadata.branchAtTurn)}` : ''}`} />
          ) : null}
          {metadataText(detail.data.metadata.resumed) === 'true' || detail.data.metadata.resumeMessageCount ? (
            <Fact label="resumed" value={`${detail.data.metadata.resumeMessageCount ?? '?'} prior msgs`} />
          ) : null}
        </div>
      ) : null}
      {observability.data ? (
        <div className="fact-list">
          <Fact label="events" value={String(observability.data.eventCount)} />
          <Fact label="turns" value={String(observability.data.turnCount)} />
          <Fact label="tokens" value={String(observability.data.totalUsage.totalTokens)} />
          <Fact label="tools" value={observability.data.tools.names.join(', ') || observability.data.tools.status} />
          <Fact label="models" value={observability.data.models.names.join(', ') || observability.data.models.status} />
        </div>
      ) : null}
      {detail.data ? (
        <div className="definition-list compact-definition-list">
          <Definition term="created" text={formatDate(detail.data.createdAt)} />
          <Definition term="updated" text={formatDate(detail.data.updatedAt)} />
          <Definition term="turns" text={String(detail.data.turns.length)} />
          <Definition term="messages" text={String(detail.data.messages.length)} />
        </div>
      ) : null}
      {verification.data && verification.data.count > 0 ? (
        <div className="fact-list">
          <Fact label="verification" value={verification.data.records.map(r =>
            `${r.checkName}: ${r.status}${r.outputSummary ? ` (${r.outputSummary.slice(0, 40)})` : ''}`
          ).join('; ')} />
        </div>
      ) : null}
      <div className="event-timeline">
        {(events.data?.events ?? []).slice(-80).map((event, idx, arr) => {
          const category = eventCategory(event.type);
          const isNewTurn = idx === 0 || event.turn !== (arr[idx - 1]?.turn ?? 0);
          const payloadSummary = eventPayloadSummary(event);
          return (
            <div className={`event-line${isNewTurn ? ' turn-break' : ''}`} data-category={category} key={event.id}>
              <span className="event-time">{formatTime(event.createdAt)}</span>
              <span className={`event-dot ${category}`} />
              <strong>{event.type}</strong>
              {event.toolName ? <em>{event.toolName}</em> : null}
              {event.model ? <em className="event-model">{event.model}</em> : null}
              {payloadSummary ? <span className="event-summary">{payloadSummary}</span> : null}
            </div>
          );
        })}
      </div>
      <div className="section-divider">
        <div className="mini-timeline-head">
          <strong>Related Todos</strong>
          <span>{String(relatedTodos.data?.length ?? 0)}</span>
        </div>
        {(relatedTodos.data ?? []).length === 0 ? (
          <EmptyText text="No linked todos found." />
        ) : relatedTodos.data!.slice(0, 8).map(todo => (
          <button className="record-row compact-record" type="button" key={todo.id} onClick={() => onSelectTodo(todo.id)}>
            <span className="row-title">{todo.title}</span>
            <span className={`status-text ${todo.status}`}>{todo.status}</span>
            <span>{todo.taskRunId ?? todo.traceId ?? 'linked'}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

function eventCategory(type: string): string {
  if (type.startsWith('session.')) return 'session';
  if (type.startsWith('model.')) return 'model';
  if (type.startsWith('tool.')) return 'tool';
  if (type.startsWith('task.')) return 'task';
  return 'other';
}

function eventPayloadSummary(event: { payload?: Record<string, unknown> }): string | null {
  const p = event.payload;
  if (!p) return null;
  if (typeof p.textPreview === 'string' && p.textPreview) return p.textPreview.slice(0, 60);
  if (typeof p.contentPreview === 'string' && p.contentPreview) return p.contentPreview.slice(0, 60);
  if (typeof p.toolCalls === 'object') {
    const calls = p.toolCalls as Array<Record<string, unknown>>;
    if (Array.isArray(calls) && calls.length > 0) {
      return calls.map(c => String(c.name ?? '?')).join(', ');
    }
  }
  if (typeof p.callId === 'string') return `call: ${p.callId.slice(0, 12)}`;
  if (typeof p.argsPreview === 'string') return p.argsPreview.slice(0, 60);
  return null;
}

function buildRelatedTodoUrls(sessionId: string | null, metadata: Record<string, unknown>): string[] {
  const filters: Array<[string, string | null]> = [
    ['sessionId', sessionId],
    ['taskRunId', metadataText(metadata.taskRunId)],
    ['traceId', metadataText(metadata.traceId)],
    ['requestId', metadataText(metadata.requestId)],
  ];
  const urls: string[] = [];
  for (const [key, value] of filters) {
    if (!value) continue;
    const query = new URLSearchParams({ [key]: value, includeArchived: 'true', limit: '50' });
    urls.push(`/todos?${query.toString()}`);
  }
  return Array.from(new Set(urls));
}

function dedupeTodos(todos: TodoItem[]): TodoItem[] {
  const byId = new Map<string, TodoItem>();
  for (const todo of todos) byId.set(todo.id, todo);
  return [...byId.values()];
}

export function TasksPage({ onSelectSession }: { onSelectSession: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [showRunSpecs, setShowRunSpecs] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const tasks = useQuery({
    queryKey: ['tasks', statusFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      return getJson<TaskRun[]>(`/tasks?${params.toString()}`);
    },
    refetchInterval: 8_000,
  });
  const runSpecs = useQuery({
    queryKey: ['runs'],
    queryFn: () => getJson<RunSpec[]>('/runs'),
    refetchInterval: 10_000,
    enabled: showRunSpecs,
  });
  const selectedTask = (tasks.data ?? []).find(task => task.id === selectedTaskId) ?? null;
  const cancel = useMutation({
    mutationFn: (id: string) => postJson(`/tasks/${id}/cancel`, { reason: 'cancelled_from_tasks_page' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tasks'] }),
  });

  return (
    <section className="panel-grid detail-grid">
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Tasks</h2>
            <p>Scheduler records above chat sessions. Cancel is available only for active tasks.</p>
          </div>
          <div className="toolbar">
            <select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
              <option value="">all status</option>
              <option value="queued">queued</option>
              <option value="running">running</option>
              <option value="succeeded">succeeded</option>
              <option value="failed">failed</option>
              <option value="cancelled">cancelled</option>
            </select>
            <button className={`ghost-btn ${showRunSpecs ? 'active' : ''}`} type="button" onClick={() => setShowRunSpecs(prev => !prev)}>
              <GitGraph size={14} /> run specs
            </button>
            <RefreshQueryButton queryKey={['tasks']} />
          </div>
        </div>
        <DataTable
          loading={tasks.isLoading}
          empty="No tasks yet."
          rows={tasks.data ?? []}
          renderRow={task => (
            <div className="record-row task-row" data-active={selectedTaskId === task.id}>
              <div className="task-main">
                <button type="button" className="link-cell" onClick={() => onSelectSession(task.sessionId)}>
                  {task.id}
                </button>
                <span>{task.promptPreview}</span>
              </div>
              <span className={`status-text ${task.status}`}>{task.status}</span>
              <span>{task.toolMode}</span>
              <span>{task.provider ?? 'default'} / {task.model ?? 'model?'}</span>
              <span>{task.nodeId ?? 'local'}</span>
              <span>{formatDate(task.updatedAt)}</span>
              <button className="tiny-btn" type="button" onClick={() => setSelectedTaskId(task.id)}>
                <Search size={12} /> inspect
              </button>
              <button className="tiny-btn" type="button" disabled={!['queued', 'running'].includes(task.status) || cancel.isPending} onClick={() => cancel.mutate(task.id)}>
                cancel
              </button>
            </div>
          )}
        />
        {showRunSpecs ? (
          <div className="section-divider">
            <div className="panel-head compact">
              <h2>Run Specs</h2>
              <RefreshQueryButton queryKey={['runs']} />
            </div>
            <DataTable
              loading={runSpecs.isLoading}
              empty="No run specs found."
              rows={runSpecs.data ?? []}
              renderRow={run => (
                <div className="record-row" key={run.id}>
                  <span className="row-title">{run.id}</span>
                  <span className={`status-text ${run.status}`}>{run.status}</span>
                  <span>session: {run.sessionId.slice(0, 12)}...</span>
                  <span>{formatDate(run.updatedAt)}</span>
                  <button className="tiny-btn" type="button" onClick={() => setSelectedTaskId(run.taskRunId ?? null)}>
                    <Search size={12} /> task
                  </button>
                </div>
              )}
            />
          </div>
        ) : null}
      </div>
      <TaskRunInspector task={selectedTask} />
    </section>
  );
}

function TaskRunInspector({ task }: { task: TaskRun | null }) {
  const inspect = useMutation({
    mutationFn: (runSpecId: string) => getJson(`/runs/${runSpecId}/inspect`),
  });
  const recover = useMutation({
    mutationFn: (runSpecId: string) => postJson(`/runs/${runSpecId}/recover`, {}),
  });
  const verify = useMutation({
    mutationFn: (runSpecId: string) => postJson(`/runs/${runSpecId}/verify`, {}),
  });
  const agentGraph = useMutation({
    mutationFn: (taskId: string) => getJson<AgentTaskGraph>(`/agent-graphs/${taskId}`),
  });
  const agentGraphCompletion = useMutation({
    mutationFn: (taskId: string) => getJson<AgentTaskGraphCompletion>(`/agent-graphs/${taskId}/completion`),
  });
  const runSpecId = task?.runSpecId;
  const latestResult = verify.data ?? recover.data ?? inspect.data;
  const graphResult = agentGraph.data ?? agentGraphCompletion.data;

  if (!task) {
    return <aside className="panel inspector"><EmptyText text="Select a task to inspect run evidence and recovery state." /></aside>;
  }

  return (
    <aside className="panel inspector">
      <div className="panel-head compact">
        <h2>Task Run</h2>
        <span className={`status-text ${task.status}`}>{task.status}</span>
      </div>
      <span className="mono-chip">{task.id}</span>
      <div className="fact-list compact-facts">
        <Fact label="run spec" value={runSpecId ?? 'none'} />
        <Fact label="session" value={task.sessionId} />
        <Fact label="trace" value={task.traceId} />
        <Fact label="attempt" value={String(task.attempt)} />
        <Fact label="node" value={task.nodeId ?? 'local'} />
        <Fact label="heartbeat" value={task.heartbeatAt ? formatDate(task.heartbeatAt) : 'none'} />
        {task.leaseExpiresAt ? <Fact label="lease expires" value={formatDate(task.leaseExpiresAt)} /> : null}
      </div>
      <div className="inline-actions">
        <button className="ghost-btn" type="button" disabled={!runSpecId || inspect.isPending} onClick={() => runSpecId && inspect.mutate(runSpecId)}>
          <Search size={14} /> inspect
        </button>
        <button className="ghost-btn" type="button" disabled={!runSpecId || recover.isPending} onClick={() => runSpecId && recover.mutate(runSpecId)}>
          <Database size={14} /> recover
        </button>
        <button className="ghost-btn" type="button" disabled={!runSpecId || verify.isPending} onClick={() => runSpecId && verify.mutate(runSpecId)}>
          <Send size={14} /> verify
        </button>
        <button className="ghost-btn" type="button" disabled={agentGraph.isPending || agentGraphCompletion.isPending} onClick={() => { agentGraph.mutate(task.id); agentGraphCompletion.mutate(task.id); }}>
          <GitGraph size={14} /> graph
        </button>
      </div>
      {graphResult ? (
        <div className="json-block">
          <strong>Agent Task Graph</strong>
          <pre>{JSON.stringify(graphResult, null, 2)}</pre>
        </div>
      ) : null}
      {latestResult ? (
        <div className="json-block">
          <strong>Run Operation Result</strong>
          <pre>{JSON.stringify(latestResult, null, 2)}</pre>
        </div>
      ) : (
        !graphResult ? <EmptyText text={runSpecId ? 'No run operation loaded.' : 'Task has no run spec link.'} /> : null
      )}
    </aside>
  );
}

export function MemoryPage() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [scopeFilter, setScopeFilter] = useState('');
  const [layerFilter, setLayerFilter] = useState('');
  const [archivedFilter, setArchivedFilter] = useState('false');
  const [projectFilter, setProjectFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [content, setContent] = useState('');
  const [kind, setKind] = useState('note');
  const [source, setSource] = useState('user');
  const [tags, setTags] = useState('web-console');
  const [scope, setScope] = useState('project');
  const [memoryLayer, setMemoryLayer] = useState('semantic');
  const [promotable, setPromotable] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const memory = useQuery({
    queryKey: ['memory', query, kindFilter, sourceFilter, scopeFilter, layerFilter, archivedFilter, projectFilter, tagFilter],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '120' });
      if (query.trim()) params.set('q', query.trim());
      if (kindFilter) params.set('kind', kindFilter);
      if (sourceFilter) params.set('source', sourceFilter);
      if (scopeFilter) params.set('scope', scopeFilter);
      if (layerFilter) params.set('memoryLayer', layerFilter);
      if (archivedFilter) params.set('archived', archivedFilter);
      if (projectFilter.trim()) params.set('projectId', projectFilter.trim());
      if (tagFilter.trim()) params.set('tag', tagFilter.trim());
      return getJson<MemoryResponse>(`/memory?${params.toString()}`);
    },
  });
  const stats = useQuery({
    queryKey: ['memory-stats'],
    queryFn: () => getJson<MemoryStats>('/memory/stats'),
  });
  const workspace = useQuery({
    queryKey: ['workspace'],
    queryFn: () => getJson<{ workspaceRoot: string }>('/workspace'),
    staleTime: 60_000,
  });
  const selected = (memory.data?.results ?? []).find(obs => obs.id === selectedId) ?? null;
  const add = useMutation({
    mutationFn: () => postJson('/memory', {
      title,
      summary,
      content,
      kind,
      tags: splitCsv(tags),
      source,
      metadata: {
        scope,
        memoryLayer,
        archived: false,
        promotable,
      },
    }),
    onSuccess: async () => {
      setTitle('');
      setSummary('');
      setContent('');
      await queryClient.invalidateQueries({ queryKey: ['memory'] });
      await queryClient.invalidateQueries({ queryKey: ['memory-stats'] });
    },
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Partial<MemoryObservation> }) => patchJson<MemoryObservation>(`/memory/${id}`, body),
    onSuccess: async (obs) => {
      setSelectedId(obs.id);
      await queryClient.invalidateQueries({ queryKey: ['memory'] });
      await queryClient.invalidateQueries({ queryKey: ['memory-stats'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => deleteJson(`/memory/${id}`),
    onSuccess: async () => {
      setSelectedId(null);
      await queryClient.invalidateQueries({ queryKey: ['memory'] });
      await queryClient.invalidateQueries({ queryKey: ['memory-stats'] });
    },
  });
  const sync = useMutation({
    mutationFn: () => postJson('/memory/sync-md', {
      workspaceRoot: workspace.data?.workspaceRoot ?? '',
      scope: scopeFilter || undefined,
      memoryLayer: layerFilter || undefined,
      archived: archivedFilter === '' ? undefined : archivedFilter === 'true',
      projectId: projectFilter || undefined,
    }),
  });

  const patchSelectedMetadata = (patch: Record<string, unknown>, extra?: Partial<MemoryObservation>) => {
    if (!selected) return;
    update.mutate({
      id: selected.id,
      body: {
        ...extra,
        metadata: {
          ...selected.metadata,
          ...patch,
        },
      },
    });
  };

  const activeFilterCount = [kindFilter, sourceFilter, scopeFilter, layerFilter, archivedFilter !== 'false' ? archivedFilter : '', projectFilter.trim(), tagFilter.trim()].filter(Boolean).length;

  function clearFilters() {
    setQuery('');
    setKindFilter('');
    setSourceFilter('');
    setScopeFilter('');
    setLayerFilter('');
    setArchivedFilter('false');
    setProjectFilter('');
    setTagFilter('');
  }

  return (
    <section className="panel-grid memory-grid">
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Memory</h2>
            <p>Classify observations by scope, memory layer, project, and archive state.</p>
          </div>
          <div className="toolbar">
            <div className="search-box">
              <Search size={14} />
              <input value={query} onChange={event => setQuery(event.target.value)} placeholder="search memory" />
            </div>
            <div className="filter-toggle">
              <button className="ghost-btn" type="button" onClick={() => setShowFilters(prev => !prev)}>
                <SlidersHorizontal size={14} /> filters
              </button>
              {activeFilterCount > 0 ? <span className="filter-badge">{activeFilterCount}</span> : null}
            </div>
            {activeFilterCount > 0 ? (
              <button className="ghost-btn" type="button" onClick={clearFilters}>
                <X size={14} /> clear
              </button>
            ) : null}
            <button className="ghost-btn" type="button" disabled={sync.isPending || !workspace.data?.workspaceRoot} onClick={() => sync.mutate()}>
              <FileText size={14} /> sync md
            </button>
            <RefreshQueryButton queryKey={['memory']} />
          </div>
        </div>
        <div className={`filter-bar ${showFilters ? '' : 'collapsed'}`}>
          <div className="filter-row">
            <select value={kindFilter} onChange={event => setKindFilter(event.target.value)}>
              <option value="">all kinds</option>
              <option value="note">note</option>
              <option value="fact">fact</option>
              <option value="rule">rule</option>
              <option value="decision">decision</option>
            </select>
            <select value={sourceFilter} onChange={event => setSourceFilter(event.target.value)}>
              <option value="">all sources</option>
              <option value="user">user</option>
              <option value="agent">agent</option>
              <option value="system">system</option>
            </select>
            <select value={scopeFilter} onChange={event => setScopeFilter(event.target.value)}>
              <option value="">all scopes</option>
              <option value="global">global</option>
              <option value="workspace">workspace</option>
              <option value="project">project</option>
              <option value="session">session</option>
            </select>
          </div>
          <div className="filter-row">
            <select value={layerFilter} onChange={event => setLayerFilter(event.target.value)}>
              <option value="">all layers</option>
              <option value="working">working</option>
              <option value="episodic">episodic</option>
              <option value="semantic">semantic</option>
              <option value="procedural">procedural</option>
              <option value="preference">preference</option>
            </select>
            <select value={archivedFilter} onChange={event => setArchivedFilter(event.target.value)}>
              <option value="">archive any</option>
              <option value="false">active</option>
              <option value="true">archived</option>
            </select>
            <input value={projectFilter} onChange={event => setProjectFilter(event.target.value)} placeholder="project id" />
            <input value={tagFilter} onChange={event => setTagFilter(event.target.value)} placeholder="tag" />
          </div>
        </div>
        <div className="memory-list">
          {memory.isLoading ? <EmptyText text="Loading memory..." /> : null}
          {(memory.data?.results ?? []).map(obs => (
            <button className="memory-row" data-active={selectedId === obs.id} key={obs.id} type="button" onClick={() => setSelectedId(obs.id)}>
              <div>
                <h3>{obs.title}</h3>
                <p>{obs.summary || 'No summary'}</p>
                <span>
                  {obs.kind} · {obs.source} · {metadataText(obs.metadata.scope) ?? 'scope?'} · {metadataText(obs.metadata.memoryLayer) ?? 'layer?'} · {isArchived(obs) ? 'archived' : 'active'} · {formatDate(obs.updatedAt)}
                </span>
              </div>
            </button>
          ))}
          {!memory.isLoading && (memory.data?.results ?? []).length === 0 ? <EmptyText text="No memory records match the filters." /> : null}
        </div>
      </div>
      <aside className="panel inspector">
        <div className="panel-head compact">
          <h2>{selected ? 'Memory Detail' : 'Add Observation'}</h2>
        </div>
        {selected ? (
          <>
            <span className="mono-chip">memory-{selected.id}</span>
            <div className="fact-list">
              <Fact label="scope" value={metadataText(selected.metadata.scope) ?? 'unspecified'} />
              <Fact label="layer" value={metadataText(selected.metadata.memoryLayer) ?? 'unspecified'} />
              <Fact label="archived" value={String(isArchived(selected))} />
              <Fact label="project" value={selected.projectId ?? 'none'} />
              <Fact label="session" value={selected.sessionId ?? 'none'} />
              <Fact label="trace" value={selected.traceId ?? 'none'} />
            </div>
            <div className="toolbar">
              {isArchived(selected) ? (
                <button className="ghost-btn" type="button" onClick={() => patchSelectedMetadata({ archived: false, archiveReason: undefined })}>
                  <RotateCcw size={14} /> restore
                </button>
              ) : (
                <button className="ghost-btn" type="button" onClick={() => patchSelectedMetadata({ archived: true, archiveReason: 'archived_from_memory_page' })}>
                  <Archive size={14} /> archive
                </button>
              )}
              <button className="ghost-btn" type="button" onClick={() => patchSelectedMetadata({ scope: 'project', memoryLayer: 'semantic', archived: false }, { tags: mergeTags(selected.tags, ['semantic']) })}>
                <Layers size={14} /> project semantic
              </button>
              <button className="icon-btn danger" type="button" onClick={() => remove.mutate(selected.id)} title="delete memory">
                <Trash2 size={14} />
              </button>
            </div>
            <div className="definition-list compact-definition-list">
              <Definition term="title" text={selected.title} />
              <Definition term="summary" text={selected.summary || 'none'} />
              <Definition term="tags" text={selected.tags.join(', ') || 'none'} />
              <Definition term="created" text={formatDate(selected.createdAt)} />
              <Definition term="updated" text={formatDate(selected.updatedAt)} />
            </div>
            {selected.content ? (
              <div className="json-block">
                <strong>Content</strong>
                <pre>{selected.content}</pre>
              </div>
            ) : null}
            <div className="json-block">
              <strong>Metadata</strong>
              <pre>{JSON.stringify(selected.metadata, null, 2)}</pre>
            </div>
          </>
        ) : null}
        <form className="stack-form" onSubmit={(event) => { event.preventDefault(); if (title.trim()) add.mutate(); }}>
          <div className="panel-head compact">
            <h2>Add Observation</h2>
          </div>
          <Field label="title">
            <input value={title} onChange={event => setTitle(event.target.value)} placeholder="short memory title" />
          </Field>
          <Field label="summary">
            <textarea value={summary} onChange={event => setSummary(event.target.value)} rows={3} placeholder="what should future runs know?" />
          </Field>
          <Field label="content">
            <textarea value={content} onChange={event => setContent(event.target.value)} rows={4} placeholder="optional details or evidence" />
          </Field>
          <Field label="kind">
            <select value={kind} onChange={event => setKind(event.target.value)}>
              <option value="note">note</option>
              <option value="fact">fact</option>
              <option value="rule">rule</option>
              <option value="decision">decision</option>
            </select>
          </Field>
          <Field label="source">
            <select value={source} onChange={event => setSource(event.target.value)}>
              <option value="user">user</option>
              <option value="agent">agent</option>
              <option value="system">system</option>
            </select>
          </Field>
          <Field label="scope">
            <select value={scope} onChange={event => setScope(event.target.value)}>
              <option value="project">project</option>
              <option value="workspace">workspace</option>
              <option value="global">global</option>
              <option value="session">session</option>
            </select>
          </Field>
          <Field label="layer">
            <select value={memoryLayer} onChange={event => setMemoryLayer(event.target.value)}>
              <option value="semantic">semantic</option>
              <option value="procedural">procedural</option>
              <option value="preference">preference</option>
              <option value="episodic">episodic</option>
              <option value="working">working</option>
            </select>
          </Field>
          <Field label="tags">
            <input value={tags} onChange={event => setTags(event.target.value)} placeholder="comma separated tags" />
          </Field>
          <label className="toolbar-toggle">
            <input type="checkbox" checked={promotable} onChange={event => setPromotable(event.target.checked)} />
            promotable
          </label>
          <Field label="scope guide">
            <p className="muted-copy">global is cross-project preference/procedure; project is tied to request project context; session is run history or smoke evidence.</p>
          </Field>
          <button className="primary-btn" type="submit" disabled={!title.trim() || add.isPending}>
            <Database size={14} /> save
          </button>
        </form>
        <div className="fact-list">
          <Fact label="total" value={String(stats.data?.totalObservations ?? 0)} />
          <Fact label="archived" value={String(stats.data?.archived ?? 0)} />
          <Fact label="kinds" value={Object.keys(stats.data?.byKind ?? {}).join(', ') || 'none'} />
          <Fact label="sources" value={Object.keys(stats.data?.bySource ?? {}).join(', ') || 'none'} />
          <Fact label="scopes" value={Object.keys(stats.data?.byScope ?? {}).join(', ') || 'none'} />
          <Fact label="layers" value={Object.keys(stats.data?.byLayer ?? {}).join(', ') || 'none'} />
        </div>
      </aside>
    </section>
  );
}

function splitCsv(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function isArchived(obs: MemoryObservation): boolean {
  return obs.metadata.archived === true || obs.metadata.archived === 'true';
}

function mergeTags(current: string[], next: string[]): string[] {
  return Array.from(new Set([...current, ...next].map(tag => tag.trim()).filter(Boolean)));
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
          renderRow={(provider, index) => {
            const readiness = provider.readiness ?? {};
            const state = providerReadinessLabel(readiness);
            const detail = providerReadinessDetail(provider, readiness);
            return (
              <div className="record-row provider-row">
                <span className="row-title">{metadataText(provider.name) ?? metadataText(provider.provider) ?? `provider-${index + 1}`}</span>
                <span>{metadataText(provider.source) ?? 'source?'}</span>
                <span>{metadataText(provider.defaultModel) ?? metadataText(provider.model) ?? 'model?'}</span>
                <span className={`status-text ${readiness.ready ? 'succeeded' : readiness.manualSetupRequired ? 'blocked' : 'ready'}`}>{state}</span>
                <span>{detail}</span>
              </div>
            );
          }}
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
              <span>{route.hasApiKey ? 'key set' : 'no key'} · {route.source ?? 'manual'}</span>
            </div>
          )}
        />
      </div>
      <aside className="panel inspector">
        <ProviderConfigWorkspace />
        <div className="section-divider" />
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

type ProviderConfigDraft = {
  providerId: string;
  apiKeyEnv: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
};

function ProviderConfigWorkspace() {
  const [draft, setDraft] = useState<ProviderConfigDraft>({
    providerId: 'deepseek',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    enabled: true,
  });
  const [copied, setCopied] = useState<'env' | 'yaml' | null>(null);
  const envSnippet = buildProviderEnvSnippet(draft);
  const yamlSnippet = buildProviderYamlSnippet(draft);

  async function copySnippet(kind: 'env' | 'yaml', text: string) {
    await navigator.clipboard?.writeText(text);
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1600);
  }

  function setProviderId(value: string) {
    const providerId = value.trim();
    setDraft(prev => ({
      ...prev,
      providerId,
      apiKeyEnv: providerId ? `${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY` : prev.apiKeyEnv,
    }));
  }

  return (
    <div className="provider-config-workspace">
      <div className="panel-head compact">
        <h2>Provider Settings</h2>
        <StatusPill status="partial" />
      </div>
      <Field label="provider id">
        <input value={draft.providerId} onChange={event => setProviderId(event.target.value)} placeholder="deepseek" />
      </Field>
      <Field label="api key env">
        <input value={draft.apiKeyEnv} onChange={event => setDraft(prev => ({ ...prev, apiKeyEnv: event.target.value }))} placeholder="DEEPSEEK_API_KEY" />
      </Field>
      <Field label="base url">
        <input value={draft.baseUrl} onChange={event => setDraft(prev => ({ ...prev, baseUrl: event.target.value }))} placeholder="https://api.deepseek.com" />
      </Field>
      <Field label="default model">
        <input value={draft.model} onChange={event => setDraft(prev => ({ ...prev, model: event.target.value }))} placeholder="deepseek-v4-flash" />
      </Field>
      <label className="toolbar-toggle provider-toggle">
        <input type="checkbox" checked={draft.enabled} onChange={event => setDraft(prev => ({ ...prev, enabled: event.target.checked }))} />
        enabled
      </label>
      <ConfigSnippet
        title=".env"
        value={envSnippet}
        copied={copied === 'env'}
        onCopy={() => copySnippet('env', envSnippet)}
      />
      <ConfigSnippet
        title="~/.los/config.yaml"
        value={yamlSnippet}
        copied={copied === 'yaml'}
        onCopy={() => copySnippet('yaml', yamlSnippet)}
      />
    </div>
  );
}

function ConfigSnippet({
  title,
  value,
  copied,
  onCopy,
}: {
  title: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="config-note">
      <div className="snippet-head">
        <strong>{title}</strong>
        <button className="tiny-btn" type="button" onClick={onCopy}>
          <Copy size={12} /> {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <code>{value}</code>
    </div>
  );
}

function buildProviderEnvSnippet(draft: ProviderConfigDraft): string {
  const prefix = envPrefixForProvider(draft.providerId);
  const apiKeyEnv = normalizeEnvName(draft.apiKeyEnv) || `${prefix}_API_KEY`;
  return [
    `${apiKeyEnv}=...`,
    `${prefix}_BASE_URL=${draft.baseUrl.trim() || 'https://api.example.com/v1'}`,
    `${prefix}_MODEL=${draft.model.trim() || 'model-id'}`,
  ].join('\n');
}

function buildProviderYamlSnippet(draft: ProviderConfigDraft): string {
  const providerId = sanitizeProviderId(draft.providerId) || 'provider';
  const apiKeyEnv = normalizeEnvName(draft.apiKeyEnv) || `${envPrefixForProvider(providerId)}_API_KEY`;
  const baseUrl = draft.baseUrl.trim() || 'https://api.example.com/v1';
  const model = draft.model.trim() || 'model-id';
  return [
    'providers:',
    `  ${providerId}:`,
    `    apiKey: "\${${apiKeyEnv}}"`,
    `    baseUrl: "${baseUrl}"`,
    `    model: "${model}"`,
    `    enabled: ${draft.enabled ? 'true' : 'false'}`,
  ].join('\n');
}

function providerReadinessLabel(readiness: ProviderReadiness): string {
  if (readiness.ready) return 'ready';
  if (readiness.manualSetupRequired) return 'manual setup';
  if (readiness.discovered) return 'discovered';
  return 'unknown';
}

function providerReadinessDetail(provider: ProviderDiscoveryProvider, readiness: ProviderReadiness): string {
  const blocker = metadataText(readiness.blocker);
  if (blocker) return blocker;
  if (readiness.configuredKey !== undefined) {
    return readiness.configuredKey ? 'configured key' : 'no configured key';
  }
  if (provider.hasApiKey !== undefined) {
    return provider.hasApiKey ? 'configured key' : 'no configured key';
  }
  return 'readiness unknown';
}

function envPrefixForProvider(providerId: string): string {
  return (sanitizeProviderId(providerId) || 'provider').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function normalizeEnvName(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
}

function sanitizeProviderId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

async function exportSession(sessionId: string) {
  const detail = await getJson<SessionDetail>(`/sessions/${sessionId}`);
  const blob = new Blob([JSON.stringify(detail, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `los-session-${sessionId}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function DeleteSessionButton({ sessionId }: { sessionId: string }) {
  const [confirming, setConfirming] = useState(false);
  const queryClient = useQueryClient();

  if (confirming) {
    return (
      <span className="inline-confirm">
        <button className="ghost-btn danger" type="button" onClick={async () => {
          await deleteJson(`/sessions/${sessionId}`);
          setConfirming(false);
          void queryClient.invalidateQueries({ queryKey: ['sessions'] });
        }}>
          <Trash2 size={14} /> confirm delete
        </button>
        <button className="ghost-btn" type="button" onClick={() => setConfirming(false)}>
          <X size={14} />
        </button>
      </span>
    );
  }

  return (
    <button className="ghost-btn" type="button" onClick={() => setConfirming(true)} title="Delete this session">
      <Trash2 size={14} />
    </button>
  );
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
