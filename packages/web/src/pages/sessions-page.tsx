import { useState, useMemo, type ChangeEvent } from 'react';
import { metadataText } from '../chat-helpers.js';
import {
  eventCategory,
  eventPayloadSummary,
  ExpandableEvent,
  HIDDEN_INSPECTOR_EVENTS,
  TurnGroup,
} from './session-inspector.js';
import { ExecutionObservabilityPanel } from './execution-observability-panel.js';
import { TimelinePanel } from './timeline-panel.js';
import { useSessionEventStream } from '../hooks/useSessionEventStream.js';
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
import { useI18n } from '../i18n';

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
  const { t } = useI18n();
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
        setImportMessage(t('assets.sessions.imported', { id: res.id ?? t('assets.sessions.session') }));
        void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      } else {
        setImportMessage(res.error ?? t('assets.sessions.importFailed'));
      }
    } catch (err: any) {
      setImportMessage(err?.message ?? t('assets.sessions.importFailed'));
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
            <h2>{t('assets.sessions.title')}</h2>
            <p>{t('assets.sessions.subtitle')}</p>
          </div>
          <div className="toolbar">
            <div className="search-box">
              <Search size={14} />
              <input value={search} onChange={event => setSearch(event.target.value)} placeholder={t('assets.sessions.searchPh')} />
            </div>
            {providers.length > 1 ? (
              <select className="filter-select" value={providerFilter} onChange={event => setProviderFilter(event.target.value)} title={t('assets.sessions.filterByProvider')}>
                <option value="">{t('assets.sessions.allProviders')}</option>
                {providers.map(p => <option value={p} key={p}>{p}</option>)}
              </select>
            ) : null}
            {models.length > 1 ? (
              <select className="filter-select" value={modelFilter} onChange={event => setModelFilter(event.target.value)} title={t('assets.sessions.filterByModel')}>
                <option value="">{t('assets.sessions.allModels')}</option>
                {models.map(m => <option value={m} key={m}>{m}</option>)}
              </select>
            ) : null}
            <label className="ghost-btn" title={t('assets.sessions.importTitle')}>
              <input type="file" accept=".json" style={{ display: 'none' }} onChange={handleImportFile} disabled={importing} />
              <Upload size={14} /> {importing ? t('assets.sessions.importing') : t('assets.sessions.import')}
            </label>
            <RefreshQueryButton queryKey={['sessions']} />
            {importMessage ? <span className="mono-chip">{importMessage}</span> : null}
          </div>
        </div>
        <DataTable
          loading={sessions.isLoading}
          empty={t('assets.sessions.emptyList')}
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
                {branchFrom ? <span title={t('assets.sessions.branchedFrom', { id: branchFrom })}><GitGraph size={13} /></span> : null}
                {session.id}
              </span>
              <span>{formatDate(session.updatedAt)}</span>
              <span>{metadataText(session.metadata.provider) ?? t('assets.sessions.providerUnknown')}</span>
              <span>{metadataText(session.metadata.model) ?? t('assets.sessions.modelUnknown')}</span>
              <span>{metadataText(session.metadata.toolMode) ?? t('assets.state.modeUnknown')}</span>
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
  const { t } = useI18n();
  const detail = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => getJson<SessionDetail>(`/sessions/${sessionId}`),
    enabled: Boolean(sessionId),
  });
  const events = useSessionEventStream(sessionId);
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
    return <div className="panel inspector"><EmptyText text={t('assets.sessions.selectHint')} /></div>;
  }

  return (
    <aside className="panel inspector">
      <div className="panel-head compact">
        <h2>{t('assets.sessions.detailTitle')}</h2>
        <div className="toolbar">
          <button className="ghost-btn" type="button" onClick={() => onContinueSession(sessionId)}>
            <Send size={14} /> {t('assets.sessions.continue')}
          </button>
          <button className="ghost-btn" type="button" onClick={() => onBranchSession(sessionId)} title={t('assets.sessions.branchTitle')}>
            <GitGraph size={14} /> {t('assets.sessions.branch')}
          </button>
          <button className="ghost-btn" type="button" onClick={() => exportSession(sessionId)}>
            <Copy size={14} /> {t('assets.sessions.export')}
          </button>
          <DeleteSessionButton sessionId={sessionId} />
        </div>
      </div>
      <span className="mono-chip">{sessionId}</span>
      {detail.isLoading ? <EmptyText text={t('assets.sessions.loading')} /> : null}
      {detail.data ? (
        <div className="fact-list compact-facts">
          <Fact label={t('assets.label.provider')} value={metadataText(detail.data.metadata.provider) ?? t('assets.state.default')} />
          <Fact label={t('assets.label.model')} value={metadataText(detail.data.metadata.model) ?? t('assets.state.default')} />
          <Fact label={t('assets.label.toolMode')} value={metadataText(detail.data.metadata.toolMode) ?? t('common.unknown')} />
          <Fact label={t('assets.label.workspace')} value={metadataText(detail.data.metadata.workspaceRoot) ?? t('assets.state.default')} />
          <Fact label={t('assets.label.task')} value={metadataText(detail.data.metadata.taskRunId) ?? t('common.none')} />
          {metadataText(detail.data.metadata.branchFrom) ? (
            <Fact label={t('assets.label.branchFrom')} value={`${metadataText(detail.data.metadata.branchFrom)}${metadataText(detail.data.metadata.branchAtTurn) ? ` ${t('assets.sessions.atTurn', { turn: metadataText(detail.data.metadata.branchAtTurn) ?? '' })}` : ''}`} />
          ) : null}
          {metadataText(detail.data.metadata.resumed) === 'true' || detail.data.metadata.resumeMessageCount ? (
            <Fact label={t('assets.label.resumed')} value={t('assets.sessions.priorMsgs', { count: String(detail.data.metadata.resumeMessageCount ?? '?') })} />
          ) : null}
        </div>
      ) : null}
      {observability.data ? (
        <div className="fact-list">
          <Fact label={t('assets.label.events')} value={String(observability.data.eventCount)} />
          <Fact label={t('assets.label.turns')} value={String(observability.data.turnCount)} />
          <Fact label={t('assets.label.tokens')} value={String(observability.data.totalUsage.totalTokens)} />
          <Fact label={t('assets.label.tools')} value={observability.data.tools.names.join(', ') || observability.data.tools.status} />
          <Fact label={t('assets.label.models')} value={observability.data.models.names.join(', ') || observability.data.models.status} />
        </div>
      ) : null}
      <ExecutionObservabilityPanel sessionId={sessionId} />
      <TimelinePanel sessionId={sessionId} events={events.events} />
      {detail.data ? (
        <div className="definition-list compact-definition-list">
          <Definition term={t('assets.label.created')} text={formatDate(detail.data.createdAt)} />
          <Definition term={t('assets.label.updated')} text={formatDate(detail.data.updatedAt)} />
          <Definition term={t('assets.label.turns')} text={String(detail.data.turns.length)} />
          <Definition term={t('assets.label.messages')} text={String(detail.data.messages.length)} />
        </div>
      ) : null}
      {verification.data && verification.data.count > 0 ? (
        <div className="fact-list">
          <Fact label={t('assets.label.verification')} value={(verification.data.records ?? []).map(r =>
            `${r.checkName}: ${r.status}${r.outputSummary ? ` (${r.outputSummary.slice(0, 40)})` : ''}`
          ).join('; ')} />
        </div>
      ) : null}
      <div className="event-timeline">
        <div className="mini-timeline-head">
          <strong>{t('assets.sessions.eventTimeline')}</strong>
          <span className="inspector-live" data-state={events.wsState}>
            {events.wsState === 'connected'
              ? t('assets.sessions.live')
              : events.wsState === 'reconnecting' || events.wsState === 'connecting'
                ? t('assets.sessions.reconnecting')
                : t('assets.sessions.polling')}
            <em>{String(events.events.length)}</em>
          </span>
        </div>
        {events.loading ? <EmptyText text={t('assets.sessions.loading')} /> : null}
        {!events.loading && events.error ? <EmptyText text={events.error} /> : null}
        {events.hasMoreEarlier || events.loadingEarlier ? (
          <button
            className="ghost-btn load-earlier"
            type="button"
            disabled={events.loadingEarlier}
            onClick={events.loadEarlier}
          >
            {events.loadingEarlier ? t('assets.sessions.loadingEarlier') : t('assets.sessions.loadEarlier')}
          </button>
        ) : null}
        {(() => {
          const visible = events.events
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
          <strong>{t('assets.sessions.relatedTodos')}</strong>
          <span>{String(relatedTodos.data?.length ?? 0)}</span>
        </div>
        {(relatedTodos.data ?? []).length === 0 ? (
          <EmptyText text={t('assets.sessions.noLinkedTodos')} />
        ) : (relatedTodos.data ?? []).slice(0, 8).map(todo => (
          <button className="record-row compact-record" type="button" key={todo.id} onClick={() => onSelectTodo(todo.id)}>
            <span className="row-title">{todo.title}</span>
            <span className={`status-text ${todo.status}`}>{todo.status}</span>
            <span>{todo.taskRunId ?? todo.traceId ?? t('assets.sessions.linked')}</span>
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
  const { t } = useI18n();
  const deleteMutation = useMutation({
    mutationFn: () => deleteJson(`/sessions/${encodeURIComponent(sessionId)}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['sessions'] }); },
  });
  return <button className="ghost-btn danger" type="button" onClick={() => { if (confirm(t('assets.sessions.deleteConfirm'))) deleteMutation.mutate(); }} disabled={deleteMutation.isPending}>{t('common.delete')}</button>;
}
