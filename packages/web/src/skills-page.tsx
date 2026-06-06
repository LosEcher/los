import { type FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Plus, Trash2, Zap } from 'lucide-react';
import { deleteJson, getJson, postJson } from './api';
import { DataTable, EmptyText, Fact, Field, formatDate, StatusPill } from './ui';

const RUN_MODES = ['auto', 'manual'] as const;

interface SkillRecordApi {
  name: string;
  category: string;
  description: string;
  runMode: string;
  sourcePath: string;
  versionHash: string;
  usageCount: number;
  lastUsed?: string;
  enabled: boolean;
  content: string;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export function SkillsPage() {
  const queryClient = useQueryClient();
  const [selectedName, setSelectedName] = useState<string | null>(null);

  const skills = useQuery({
    queryKey: ['skills'],
    queryFn: () => getJson<SkillRecordApi[]>('/skills'),
    refetchInterval: 15_000,
  });

  const list = skills.data ?? [];
  const selected = list.find(s => s.name === selectedName) ?? null;

  const remove = useMutation({
    mutationFn: (name: string) => deleteJson(`/skills/${encodeURIComponent(name)}`),
    onSuccess: () => {
      setSelectedName(null);
      queryClient.invalidateQueries({ queryKey: ['skills'] });
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
        </div>
        <DataTable
          loading={skills.isLoading}
          empty="No skills registered. Add your first skill below."
          rows={list}
          renderRow={skill => (
            <button
              type="button"
              className="record-row"
              data-active={selected?.name === skill.name}
              onClick={() => setSelectedName(skill.name)}
            >
              <span className="row-title">{skill.name}</span>
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
              <Fact label="category" value={selected.category} />
              <Fact label="run mode" value={selected.runMode} />
              <Fact label="source" value={selected.sourcePath || 'none'} />
              <Fact label="version" value={selected.versionHash || 'none'} />
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
                disabled={remove.isPending}
                onClick={() => remove.mutate(selected.name)}
              >
                <Trash2 size={14} /> delete
              </button>
            </div>
          </>
        ) : (
          <SkillCreate
            onCreated={(name) => {
              setSelectedName(name);
              queryClient.invalidateQueries({ queryKey: ['skills'] });
            }}
          />
        )}
      </aside>
    </section>
  );
}

function SkillCreate({ onCreated }: { onCreated: (name: string) => void }) {
  const [name, setName] = useState('');
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
        category,
        description: description.trim() || undefined,
        runMode,
        sourcePath: sourcePath.trim() || undefined,
        content: content.trim() || undefined,
        tags: tags.split(',').map(s => s.trim()).filter(Boolean),
        enabled,
      });
      setName(''); setDescription(''); setSourcePath(''); setContent(''); setTags('');
      onCreated(created.name);
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
        <Field label="category">
          <input value={category} onChange={e => setCategory(e.target.value)} placeholder="general" />
        </Field>
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
