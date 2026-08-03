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
export function MemoryPage() {
  const queryClient = useQueryClient();
  const { t } = useI18n();
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
            <h2>{t('assets.memory.title')}</h2>
            <p>{t('assets.memory.subtitle')}</p>
          </div>
          <div className="toolbar">
            <div className="search-box">
              <Search size={14} />
              <input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('assets.memory.searchPh')} />
            </div>
            <div className="filter-toggle">
              <button className="ghost-btn" type="button" onClick={() => setShowFilters(prev => !prev)}>
                <SlidersHorizontal size={14} /> {t('assets.memory.filters')}
              </button>
              {activeFilterCount > 0 ? <span className="filter-badge">{activeFilterCount}</span> : null}
            </div>
            {activeFilterCount > 0 ? (
              <button className="ghost-btn" type="button" onClick={clearFilters}>
                <X size={14} /> {t('assets.memory.clear')}
              </button>
            ) : null}
            <button className="ghost-btn" type="button" disabled={sync.isPending || !workspace.data?.workspaceRoot} onClick={() => sync.mutate()}>
              <FileText size={14} /> {t('assets.memory.syncMd')}
            </button>
            <RefreshQueryButton queryKey={['memory']} />
          </div>
        </div>
        <div className={`filter-bar ${showFilters ? '' : 'collapsed'}`}>
          <div className="filter-row">
            <select value={kindFilter} onChange={event => setKindFilter(event.target.value)}>
              <option value="">{t('assets.memory.allKinds')}</option>
              <option value="note">note</option>
              <option value="fact">fact</option>
              <option value="rule">rule</option>
              <option value="decision">decision</option>
            </select>
            <select value={sourceFilter} onChange={event => setSourceFilter(event.target.value)}>
              <option value="">{t('assets.memory.allSources')}</option>
              <option value="user">user</option>
              <option value="agent">agent</option>
              <option value="system">system</option>
            </select>
            <select value={scopeFilter} onChange={event => setScopeFilter(event.target.value)}>
              <option value="">{t('assets.memory.allScopes')}</option>
              <option value="global">global</option>
              <option value="workspace">workspace</option>
              <option value="project">project</option>
              <option value="session">session</option>
            </select>
          </div>
          <div className="filter-row">
            <select value={layerFilter} onChange={event => setLayerFilter(event.target.value)}>
              <option value="">{t('assets.memory.allLayers')}</option>
              <option value="working">working</option>
              <option value="episodic">episodic</option>
              <option value="semantic">semantic</option>
              <option value="procedural">procedural</option>
              <option value="preference">preference</option>
            </select>
            <select value={archivedFilter} onChange={event => setArchivedFilter(event.target.value)}>
              <option value="">{t('assets.memory.archiveAny')}</option>
              <option value="false">{t('assets.label.active')}</option>
              <option value="true">{t('assets.label.archived')}</option>
            </select>
            <input value={projectFilter} onChange={event => setProjectFilter(event.target.value)} placeholder={t('assets.memory.projectIdPh')} />
            <input value={tagFilter} onChange={event => setTagFilter(event.target.value)} placeholder={t('assets.memory.tagPh')} />
          </div>
        </div>
        <div className="memory-list">
          {memory.isLoading ? <EmptyText text={t('assets.memory.loading')} /> : null}
          {(memory.data?.results ?? []).map(obs => (
            <button className="memory-row" data-active={selectedId === obs.id} key={obs.id} type="button" onClick={() => setSelectedId(obs.id)}>
              <div>
                <h3>{obs.title}</h3>
                <p>{obs.summary || t('assets.memory.noSummary')}</p>
                <span>
                  {obs.kind} · {obs.source} · {metadataText(obs.metadata.scope) ?? t('assets.memory.scopeUnknown')} · {metadataText(obs.metadata.memoryLayer) ?? t('assets.memory.layerUnknown')} · {isArchived(obs) ? t('assets.label.archived') : t('assets.label.active')} · {formatDate(obs.updatedAt)}
                </span>
              </div>
            </button>
          ))}
          {!memory.isLoading && (memory.data?.results ?? []).length === 0 ? (
            stats.data?.totalObservations === 0 ? (
              <div className="empty-text">
                <p>{t('assets.memory.noObservations')}</p>
                <p className="muted-copy">{t('assets.memory.firstMemoryHint')}</p>
              </div>
            ) : (
              <EmptyText text={t('assets.memory.noMatch')} />
            )
          ) : null}
        </div>
      </div>
      <aside className="panel inspector">
        <div className="panel-head compact">
          <h2>{selected ? t('assets.memory.detailTitle') : t('assets.memory.addObservation')}</h2>
        </div>
        {selected ? (
          <>
            <span className="mono-chip">memory-{selected.id}</span>
            <div className="fact-list">
              <Fact label={t('assets.label.scope')} value={metadataText(selected.metadata.scope) ?? t('assets.state.unspecified')} />
              <Fact label={t('assets.label.layer')} value={metadataText(selected.metadata.memoryLayer) ?? t('assets.state.unspecified')} />
              <Fact label={t('assets.label.archived')} value={String(isArchived(selected))} />
              <Fact label={t('assets.label.project')} value={selected.projectId ?? t('common.none')} />
              <Fact label={t('assets.label.session')} value={selected.sessionId ?? t('common.none')} />
              <Fact label={t('assets.label.trace')} value={selected.traceId ?? t('common.none')} />
            </div>
            <div className="toolbar">
              {isArchived(selected) ? (
                <button className="ghost-btn" type="button" onClick={() => patchSelectedMetadata({ archived: false, archiveReason: undefined })}>
                  <RotateCcw size={14} /> {t('assets.memory.restore')}
                </button>
              ) : (
                <button className="ghost-btn" type="button" onClick={() => patchSelectedMetadata({ archived: true, archiveReason: 'archived_from_memory_page' })}>
                  <Archive size={14} /> {t('assets.label.archive')}
                </button>
              )}
              <button className="ghost-btn" type="button" onClick={() => patchSelectedMetadata({ scope: 'project', memoryLayer: 'semantic', archived: false }, { tags: mergeTags(selected.tags, ['semantic']) })}>
                <Layers size={14} /> {t('assets.memory.projectSemantic')}
              </button>
              <button className="icon-btn danger" type="button" onClick={() => remove.mutate(selected.id)} title={t('assets.memory.deleteTitle')}>
                <Trash2 size={14} />
              </button>
            </div>
            <div className="definition-list compact-definition-list">
              <Definition term={t('assets.label.title')} text={selected.title} />
              <Definition term={t('assets.label.summary')} text={selected.summary || t('common.none')} />
              <Definition term={t('assets.label.tags')} text={selected.tags.join(', ') || t('common.none')} />
              <Definition term={t('assets.label.created')} text={formatDate(selected.createdAt)} />
              <Definition term={t('assets.label.updated')} text={formatDate(selected.updatedAt)} />
            </div>
            {selected.content ? (
              <div className="json-block">
                <strong>{t('assets.label.content')}</strong>
                <pre>{selected.content}</pre>
              </div>
            ) : null}
            <div className="json-block">
              <strong>{t('assets.memory.metadataTitle')}</strong>
              <pre>{JSON.stringify(selected.metadata, null, 2)}</pre>
            </div>
          </>
        ) : null}
        <form className="stack-form" onSubmit={(event) => { event.preventDefault(); if (title.trim()) add.mutate(); }}>
          <div className="panel-head compact">
            <h2>{t('assets.memory.addObservation')}</h2>
          </div>
          <Field label={t('assets.label.title')}>
            <input value={title} onChange={event => setTitle(event.target.value)} placeholder={t('assets.memory.titlePh')} />
          </Field>
          <Field label={t('assets.label.summary')}>
            <textarea value={summary} onChange={event => setSummary(event.target.value)} rows={3} placeholder={t('assets.memory.summaryPh')} />
          </Field>
          <Field label={t('assets.label.content')}>
            <textarea value={content} onChange={event => setContent(event.target.value)} rows={4} placeholder={t('assets.memory.contentPh')} />
          </Field>
          <Field label={t('assets.label.kind')}>
            <select value={kind} onChange={event => setKind(event.target.value)}>
              <option value="note">note</option>
              <option value="fact">fact</option>
              <option value="rule">rule</option>
              <option value="decision">decision</option>
            </select>
          </Field>
          <Field label={t('assets.label.source')}>
            <select value={source} onChange={event => setSource(event.target.value)}>
              <option value="user">user</option>
              <option value="agent">agent</option>
              <option value="system">system</option>
            </select>
          </Field>
          <Field label={t('assets.label.scope')}>
            <select value={scope} onChange={event => setScope(event.target.value)}>
              <option value="project">project</option>
              <option value="workspace">workspace</option>
              <option value="global">global</option>
              <option value="session">session</option>
            </select>
          </Field>
          <Field label={t('assets.label.layer')}>
            <select value={memoryLayer} onChange={event => setMemoryLayer(event.target.value)}>
              <option value="semantic">semantic</option>
              <option value="procedural">procedural</option>
              <option value="preference">preference</option>
              <option value="episodic">episodic</option>
              <option value="working">working</option>
            </select>
          </Field>
          <Field label={t('assets.label.tags')}>
            <input value={tags} onChange={event => setTags(event.target.value)} placeholder={t('assets.memory.tagsPh')} />
          </Field>
          <label className="toolbar-toggle">
            <input type="checkbox" checked={promotable} onChange={event => setPromotable(event.target.checked)} />
            {t('assets.memory.promotable')}
          </label>
          <Field label={t('assets.memory.scopeGuide')}>
            <p className="muted-copy">{t('assets.memory.scopeGuideText')}</p>
          </Field>
          <button className="primary-btn" type="submit" disabled={!title.trim() || add.isPending}>
            <Database size={14} /> {t('common.save')}
          </button>
        </form>
        <div className="fact-list">
          <Fact label={t('assets.label.total')} value={String(stats.data?.totalObservations ?? 0)} />
          <Fact label={t('assets.label.archived')} value={String(stats.data?.archived ?? 0)} />
          <Fact label={t('assets.label.kinds')} value={Object.keys(stats.data?.byKind ?? {}).join(', ') || t('common.none')} />
          <Fact label={t('assets.label.sources')} value={Object.keys(stats.data?.bySource ?? {}).join(', ') || t('common.none')} />
          <Fact label={t('assets.label.scopes')} value={Object.keys(stats.data?.byScope ?? {}).join(', ') || t('common.none')} />
          <Fact label={t('assets.label.layers')} value={Object.keys(stats.data?.byLayer ?? {}).join(', ') || t('common.none')} />
        </div>

        {(compactions.data?.compactions ?? []).length > 0 ? (
          <div className="compaction-list">
            <h4>{t('assets.memory.recentCompactions')}</h4>
            {(compactions.data?.compactions ?? []).map(c => (
              <div key={c.id} className="compaction-card">
                <div className="compaction-meta">
                  <code>{c.id.slice(0, 16)}...</code>
                  <span>{t('assets.memory.compactionSession', { id: String(c.sessionId ?? '').slice(0, 12) })}</span>
                  <span>{t('assets.memory.compactionEvidence', { count: c.evidenceCount ?? 0 })}</span>
                  <span>{t('assets.memory.compactionConfidence', { percent: (Number(c.confidence) * 100).toFixed(0) })}</span>
                  <span>{formatDate(c.createdAt)}</span>
                </div>
                <div className="compaction-summary">
                  {t('assets.memory.obsCount', { count: String(c.summary.observationCount ?? 0) })}
                  {t('assets.memory.taskCount', { count: String(c.summary.taskRunCount ?? 0) })}
                  {t('assets.memory.evalCount', { count: String(c.summary.evalCount ?? 0) })}
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
          <p className="muted-copy">{t('assets.memory.noCompactions')}</p>
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
