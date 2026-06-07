import { useState, useMemo, type ChangeEvent } from 'react';
import { metadataText } from '../chat-helpers.js';
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

type CompactionRecord = {
  id: string; sessionId: string; runSpecId?: string; createdBy?: string;
  summary: Record<string, unknown>;
  proceduralCandidates?: Array<Record<string, unknown>>;
  evidenceCount?: number; confidence?: number;
  createdAt: string;
};

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
  const compactions = useQuery({
    queryKey: ['memory-compactions'],
    queryFn: () => getJson<{ count: number; compactions: CompactionRecord[] }>('/memory/compactions?limit=10'),
    refetchInterval: 30_000,
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

        {(compactions.data?.compactions ?? []).length > 0 ? (
          <div className="compaction-list">
            <h4>Recent Compactions</h4>
            {compactions.data!.compactions.map(c => (
              <div key={c.id} className="compaction-card">
                <div className="compaction-meta">
                  <code>{c.id.slice(0, 16)}...</code>
                  <span>session={String(c.sessionId ?? '').slice(0, 12)}...</span>
                  <span>evidence={c.evidenceCount}</span>
                  <span>confidence={(Number(c.confidence) * 100).toFixed(0)}%</span>
                  <span>{formatDate(c.createdAt)}</span>
                </div>
                <div className="compaction-summary">
                  obs={String(c.summary.observationCount ?? 0)}
                  tasks={String(c.summary.taskRunCount ?? 0)}
                  evals={String(c.summary.evalCount ?? 0)}
                </div>
                {(c.proceduralCandidates?.length ?? 0) > 0 ? (
                  <div className="candidate-list">
                    {c.proceduralCandidates?.map((cand, idx) => (
                      <div key={idx} className="candidate-chip">
                        <span className="candidate-name">{String(cand.name ?? '?')}</span>
                        <span className="candidate-severity" data-severity={cand.severity ?? 'warn'}>{String(cand.severity ?? 'warn')}</span>
                        <span className="candidate-rationale">{String((cand.rationale as string) ?? '').slice(0, 120)}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="muted-copy">No compactions yet. Run 'los memory compact --session-id SID' to create one.</p>
        )}
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

