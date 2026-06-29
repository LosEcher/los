import { useState, useMemo, type ChangeEvent } from 'react';
import { metadataText } from '../chat-helpers.js';
import {
  eventCategory,
  eventPayloadSummary,
  ExpandableEvent,
  HIDDEN_INSPECTOR_EVENTS,
  TurnGroup,
} from './session-inspector.js';
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
  type SessionEvent,
  type SessionEventsResponse,
  type SessionObservability,
  type SessionSummary,
  type TaskRun,
  type TodoItem,
} from '../api';
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
} from '../ui';

type RunStateProjection = {
  phase: string;
  action: string;
  blockers: Array<{ kind: string; message: string; ids: string[] }>;
  counts: {
    taskRuns: Record<string, number>;
    verificationRecords: Record<string, number>;
  };
  ids: {
    failedVerificationRecordIds: string[];
    pendingVerificationRecordIds: string[];
  };
};
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
          <Fact label="verification" value={(verification.data.records ?? []).map(r =>
            `${r.checkName}: ${r.status}${r.outputSummary ? ` (${r.outputSummary.slice(0, 40)})` : ''}`
          ).join('; ')} />
        </div>
      ) : null}
      <div className="event-timeline">
        {(() => {
          const visible = (events.data?.events ?? [])
            .filter(event => !HIDDEN_INSPECTOR_EVENTS.has(event.type))
            .slice(-80);
          // Group into turns
          const groups: Array<{ turn: number; events: typeof visible }> = [];
          for (const event of visible) {
            const last = groups[groups.length - 1];
            if (last && last.turn === event.turn) {
              last.events.push(event);
            } else {
              groups.push({ turn: event.turn, events: [event] });
            }
          }
          return groups.map(({ turn, events: turnEvents }) => (
            <TurnGroup key={turn} turn={turn} events={turnEvents}>
              {turnEvents.map((event, idx) => {
                const category = eventCategory(event.type);
                const isNewTurn = idx === 0;
                const payloadSummary = eventPayloadSummary(event);
                return (
                  <ExpandableEvent
                    key={event.id}
                    event={event}
                    category={category}
                    isNewTurn={isNewTurn}
                    payloadSummary={payloadSummary}
                  />
                );
              })}
            </TurnGroup>
          ));
        })()}
      </div>
      <div className="section-divider">
        <div className="mini-timeline-head">
          <strong>Related Todos</strong>
          <span>{String(relatedTodos.data?.length ?? 0)}</span>
        </div>
        {(relatedTodos.data ?? []).length === 0 ? (
          <EmptyText text="No linked todos found." />
        ) : (relatedTodos.data ?? []).slice(0, 8).map(todo => (
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


async function exportSession(sessionId: string) {
  const { getJson } = await import('../api/index.js');
  const events = await getJson<{ events: Array<Record<string, unknown>> }>(`/sessions/${encodeURIComponent(sessionId)}/events?limit=10000`);
  const blob = new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `session-${sessionId}.json`; a.click();
  URL.revokeObjectURL(url);
}

function DeleteSessionButton({ sessionId }: { sessionId: string }) {
  const queryClient = useQueryClient();
  const deleteMutation = useMutation({
    mutationFn: () => deleteJson(`/sessions/${encodeURIComponent(sessionId)}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['sessions'] }); },
  });
  return <button className="ghost-btn danger" type="button" onClick={() => { if (confirm('Delete this session?')) deleteMutation.mutate(); }} disabled={deleteMutation.isPending}>Delete</button>;
}
