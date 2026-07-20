import { type FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Eye, Pin, PinOff, Plus, RotateCcw, Trash2, Upload, Zap } from 'lucide-react';
import { deleteJson, getJson, postJson } from './api';
import { DataTable, EmptyText, Fact, Field, formatDate, StatusPill } from './ui';

const RUN_MODES = ['auto', 'manual'] as const;
const SCOPES = ['', 'global', 'project'] as const;

interface SkillRecordApi {
  id: string;
  name: string;
  category: string;
  description: string;
  runMode: string;
  sourcePath: string;
  versionHash: string;
  pinnedVersionHash?: string;
  usageCount: number;
  lastUsed?: string;
  enabled: boolean;
  content: string;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface SkillImportPreview {
  name: string;
  versionHash: string;
  currentVersionHash?: string;
  action: 'create' | 'update' | 'unchanged';
}

interface SkillHistoryResponse {
  currentVersionHash: string;
  pinnedVersionHash?: string;
  versions: Array<{ versionHash: string; sourcePath: string; createdAt: string }>;
}

export function SkillsPage() {
  const queryClient = useQueryClient();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [scopeFilter, setScopeFilter] = useState('');
  const [importPreview, setImportPreview] = useState<SkillImportPreview[]>([]);

  const query = new URLSearchParams();
  if (scopeFilter) query.set('scope', scopeFilter);

  const skills = useQuery({
    queryKey: ['skills', scopeFilter],
    queryFn: () => getJson<SkillRecordApi[]>(`/skills?${query.toString()}`),
    refetchInterval: 15_000,
  });
  const workspace = useQuery({
    queryKey: ['workspace'],
    queryFn: () => getJson<{ workspaceRoot: string }>('/workspace'),
    staleTime: 60_000,
  });

  const list = skills.data ?? [];
  const selected = list.find(s => skillKey(s) === selectedKey) ?? null;
  const history = useQuery({
    queryKey: ['skill-history', selected?.name, selected ? scopeValue(selected.metadata) : ''],
    queryFn: () => getJson<SkillHistoryResponse>(`/skills/${encodeURIComponent(selected!.name)}/history?scope=${encodeURIComponent(scopeValue(selected!.metadata))}`),
    enabled: Boolean(selected),
  });

  const remove = useMutation({
    mutationFn: (skill: SkillRecordApi) => deleteJson(`/skills/${encodeURIComponent(skill.name)}?scope=${encodeURIComponent(scopeValue(skill.metadata))}`),
    onSuccess: () => {
      setSelectedKey(null);
      queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
  });

  const syncToDir = useMutation({
    mutationFn: (scope: string) => postJson('/skills/sync-to-dir', {
      scope: scope || 'global',
      workspaceRoot: workspace.data?.workspaceRoot,
    }),
    onSuccess: (data: any) => alert(`Synced ${data.count} skills to ${data.scope} dir`),
  });

  const inspectImport = useMutation({
    mutationFn: (scope: string) => postJson<{ skills: SkillImportPreview[] }>('/skills/import/inspect', {
      scope: scope || 'global',
      workspaceRoot: workspace.data?.workspaceRoot,
    }),
    onSuccess: (data: any) => {
      setImportPreview(data.skills ?? []);
    },
  });

  const applyImport = useMutation({
    mutationFn: () => postJson('/skills/import/apply', {
      scope: scopeFilter || 'global',
      workspaceRoot: workspace.data?.workspaceRoot,
      expected: importPreview.map(item => ({ name: item.name, versionHash: item.versionHash })),
    }),
    onSuccess: () => {
      setImportPreview([]);
      queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
  });

  const pin = useMutation({
    mutationFn: (input: { skill: SkillRecordApi; pinned: boolean }) => postJson(`/skills/${encodeURIComponent(input.skill.name)}/pin`, {
      scope: scopeValue(input.skill.metadata),
      pinned: input.pinned,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skills'] });
      queryClient.invalidateQueries({ queryKey: ['skill-history'] });
    },
  });

  const rollback = useMutation({
    mutationFn: (input: { skill: SkillRecordApi; versionHash: string }) => postJson(`/skills/${encodeURIComponent(input.skill.name)}/rollback`, {
      scope: scopeValue(input.skill.metadata),
      versionHash: input.versionHash,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skills'] });
      queryClient.invalidateQueries({ queryKey: ['skill-history'] });
    },
  });

  return (
    <section className="panel-grid detail-grid">
      <div className="panel">
        <div className="panel-head">
          <div className="title-row">
            <Zap size={18} />
            <div>
              <h2>Skills</h2>
              <p>Reusable agent instruction bundles. Define once, reference from chat runs.</p>
            </div>
          </div>
          <StatusPill status="live" />
          <div className="toolbar">
            <select value={scopeFilter} onChange={e => setScopeFilter(e.target.value)}>
              <option value="">all scopes</option>
              {SCOPES.filter(Boolean).map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <button className="ghost-btn" type="button" disabled={syncToDir.isPending} onClick={() => syncToDir.mutate(scopeFilter)}>
              <Download size={14} /> sync
            </button>
            <button className="ghost-btn" type="button" disabled={inspectImport.isPending} onClick={() => inspectImport.mutate(scopeFilter)}>
              <Eye size={14} /> inspect
            </button>
            {importPreview.length > 0 ? (
              <button className="primary-btn" type="button" disabled={applyImport.isPending} onClick={() => applyImport.mutate()}>
                <Upload size={14} /> apply {importPreview.filter(item => item.action !== 'unchanged').length}
              </button>
            ) : null}
          </div>
        </div>
        {importPreview.length > 0 ? (
          <div className="definition-list">
            {importPreview.map(item => (
              <div className="definition" key={`${item.name}:${item.versionHash}`}>
                <strong>{item.action}</strong><span>{item.name} · {item.versionHash.slice(0, 12)}</span>
              </div>
            ))}
          </div>
        ) : null}
        <DataTable
          loading={skills.isLoading}
          empty="No skills registered. Add your first skill below."
          rows={list}
          renderRow={skill => (
            <button
              type="button"
              className="record-row"
              data-active={selected ? skillKey(selected) === skillKey(skill) : false}
              onClick={() => setSelectedKey(skillKey(skill))}
            >
              <span className="row-title">{skill.name}</span>
              <span>{scopeLabel(skill.metadata)}</span>
              <span>{skill.category}</span>
              <span>{skill.runMode}</span>
              <span>{skill.enabled ? 'enabled' : 'disabled'}</span>
              <span>{skill.usageCount} uses</span>
              <span>{formatDate(skill.updatedAt)}</span>
            </button>
          )}
        />
      </div>

      <aside className="panel inspector">
        {selected ? (
          <>
            <div className="panel-head compact">
              <h2>Skill Detail</h2>
              <span className="mono-chip">{selected.name}</span>
            </div>
            <div className="fact-list compact-facts">
              <Fact label="scope" value={scopeLabel(selected.metadata)} />
              <Fact label="layer" value={layerLabel(selected.metadata)} />
              <Fact label="category" value={selected.category} />
              <Fact label="run mode" value={selected.runMode} />
              <Fact label="source" value={selected.sourcePath || 'none'} />
              <Fact label="version" value={selected.versionHash || 'none'} />
              <Fact label="pinned" value={selected.pinnedVersionHash?.slice(0, 12) || 'no'} />
              <Fact label="uses" value={String(selected.usageCount)} />
              <Fact label="last used" value={selected.lastUsed ? formatDate(selected.lastUsed) : 'never'} />
              <Fact label="enabled" value={String(selected.enabled)} />
            </div>
            {selected.description ? (
              <div className="definition-list">
                <div className="definition"><strong>description</strong><span>{selected.description}</span></div>
              </div>
            ) : null}
            {selected.tags.length > 0 ? (
              <div className="definition-list">
                <div className="definition"><strong>tags</strong><span>{selected.tags.join(', ')}</span></div>
              </div>
            ) : null}
            {selected.content ? (
              <div className="json-block">
                <strong>Content</strong>
                <pre>{selected.content.slice(0, 2000)}{selected.content.length > 2000 ? '...' : ''}</pre>
              </div>
            ) : null}
            <div className="inline-actions">
              <button
                className="ghost-btn"
                type="button"
                disabled={pin.isPending}
                onClick={() => pin.mutate({ skill: selected, pinned: !selected.pinnedVersionHash })}
              >
                {selected.pinnedVersionHash ? <PinOff size={14} /> : <Pin size={14} />}
                {selected.pinnedVersionHash ? 'unpin' : 'pin'}
              </button>
              <button
                className="ghost-btn"
                type="button"
                disabled={remove.isPending}
                onClick={() => remove.mutate(selected)}
              >
                <Trash2 size={14} /> delete
              </button>
            </div>
            {(history.data?.versions.length ?? 0) > 1 ? (
              <div className="definition-list">
                {history.data!.versions.map(version => (
                  <div className="definition" key={version.versionHash}>
                    <strong>{version.versionHash.slice(0, 12)}</strong>
                    {version.versionHash === selected.versionHash ? <span>current</span> : (
                      <button
                        className="icon-btn"
                        type="button"
                        title="Rollback to this version"
                        disabled={rollback.isPending || Boolean(selected.pinnedVersionHash && selected.pinnedVersionHash !== version.versionHash)}
                        onClick={() => rollback.mutate({ skill: selected, versionHash: version.versionHash })}
                      ><RotateCcw size={14} /></button>
                    )}
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <SkillCreate
            onCreated={(skill) => {
              setSelectedKey(skillKey(skill));
              queryClient.invalidateQueries({ queryKey: ['skills'] });
            }}
          />
        )}
      </aside>
    </section>
  );
}

function SkillCreate({ onCreated }: { onCreated: (skill: SkillRecordApi) => void }) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState('project');
  const [category, setCategory] = useState('general');
  const [description, setDescription] = useState('');
  const [runMode, setRunMode] = useState('manual');
  const [sourcePath, setSourcePath] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError('');
    try {
      const created = await postJson<SkillRecordApi>('/skills', {
        name: name.trim(),
        scope,
        category,
        description: description.trim() || undefined,
        runMode,
        sourcePath: sourcePath.trim() || undefined,
        content: content.trim() || undefined,
        tags: tags.split(',').map(s => s.trim()).filter(Boolean),
        enabled,
      });
      setName(''); setDescription(''); setSourcePath(''); setContent(''); setTags('');
      onCreated(created);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="panel-head compact">
        <h2>Add Skill</h2>
      </div>
      <form className="stack-form" onSubmit={handleSubmit}>
        <Field label="name">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="code-review" />
        </Field>
        <div className="two-col">
          <Field label="scope">
            <select value={scope} onChange={e => setScope(e.target.value)}>
              <option value="global">global (~/.los/skills/)</option>
              <option value="project">project (.los/skills/)</option>
            </select>
          </Field>
          <Field label="category">
            <input value={category} onChange={e => setCategory(e.target.value)} placeholder="general" />
          </Field>
        </div>
        <Field label="description">
          <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} placeholder="What does this skill do?" />
        </Field>
        <Field label="run mode">
          <select value={runMode} onChange={e => setRunMode(e.target.value)}>
            {RUN_MODES.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </Field>
        <Field label="source path">
          <input value={sourcePath} onChange={e => setSourcePath(e.target.value)} placeholder="path/url to skill definition" />
        </Field>
        <Field label="content (markdown)">
          <textarea value={content} onChange={e => setContent(e.target.value)} rows={6} placeholder="# Skill Name&#10;&#10;Instructions for the agent..." />
        </Field>
        <Field label="tags (comma-separated)">
          <input value={tags} onChange={e => setTags(e.target.value)} placeholder="review, quality" />
        </Field>
        <label className="toolbar-toggle">
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
          enabled
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <button className="primary-btn" type="submit" disabled={!name.trim() || busy}>
          <Plus size={14} /> register
        </button>
      </form>
    </>
  );
}

function scopeLabel(metadata: Record<string, unknown>): string {
  const scope = metadata.scope;
  const layer = metadata.skillLayer;
  if (typeof scope === 'string') return typeof layer === 'string' ? `${scope}/${layer}` : scope;
  return typeof layer === 'string' ? `?/${layer}` : 'unspecified';
}

function layerLabel(metadata: Record<string, unknown>): string {
  return typeof metadata.skillLayer === 'string' ? metadata.skillLayer : 'unspecified';
}

function scopeValue(metadata: Record<string, unknown>): string {
  return typeof metadata.scope === 'string' ? metadata.scope : 'project';
}

function skillKey(skill: SkillRecordApi): string {
  return `${scopeValue(skill.metadata)}:${skill.name}`;
}
