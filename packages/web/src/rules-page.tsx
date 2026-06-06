import { type FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Shield, Trash2 } from 'lucide-react';
import { deleteJson, getJson, patchJson, postJson } from './api';
import { DataTable, EmptyText, Fact, Field, formatDate, StatusPill } from './ui';

const SCOPES = ['global', 'project', 'user'] as const;
const SEVERITIES = ['info', 'warn', 'error', 'block'] as const;
const ENFORCEMENT_MODES = ['advisory', 'required'] as const;
const STATUSES = ['active', 'inactive', 'draft'] as const;

interface RuleRecordApi {
  name: string;
  scope: string;
  severity: string;
  enforcementMode: string;
  status: string;
  content: string;
  lastChanged?: string;
  attachedSessions: string[];
  attachedTasks: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export function RulesPage() {
  const queryClient = useQueryClient();
  const [selectedName, setSelectedName] = useState<string | null>(null);

  const rules = useQuery({
    queryKey: ['rules'],
    queryFn: () => getJson<RuleRecordApi[]>('/rules'),
    refetchInterval: 15_000,
  });

  const list = rules.data ?? [];
  const selected = list.find(r => r.name === selectedName) ?? null;

  return (
    <section className="panel-grid detail-grid">
      <div className="panel">
        <div className="panel-head">
          <div className="title-row">
            <Shield size={18} />
            <div>
              <h2>Rules</h2>
              <p>Policy rules with scope, severity, and enforcement mode. Attach to sessions and tasks.</p>
            </div>
          </div>
          <StatusPill status="live" />
        </div>
        <DataTable
          loading={rules.isLoading}
          empty="No rules defined. Add your first rule below."
          rows={list}
          renderRow={rule => (
            <button
              type="button"
              className="record-row"
              data-active={selected?.name === rule.name}
              onClick={() => setSelectedName(rule.name)}
            >
              <span className="row-title">{rule.name}</span>
              <span>{rule.scope}</span>
              <span className={`severity-text ${rule.severity}`}>{rule.severity}</span>
              <span>{rule.enforcementMode}</span>
              <span className={`status-text ${rule.status}`}>{rule.status}</span>
              <span>{formatDate(rule.updatedAt)}</span>
            </button>
          )}
        />
      </div>

      <aside className="panel inspector">
        {selected ? (
          <RuleInspector
            rule={selected}
            onRefresh={() => queryClient.invalidateQueries({ queryKey: ['rules'] })}
            onDeselect={() => setSelectedName(null)}
          />
        ) : (
          <RuleCreate
            onCreated={(name) => {
              setSelectedName(name);
              queryClient.invalidateQueries({ queryKey: ['rules'] });
            }}
          />
        )}
      </aside>
    </section>
  );
}

function RuleInspector({
  rule,
  onRefresh,
  onDeselect,
}: {
  rule: RuleRecordApi;
  onRefresh: () => void;
  onDeselect: () => void;
}) {
  const queryClient = useQueryClient();

  const remove = useMutation({
    mutationFn: (name: string) => deleteJson(`/rules/${encodeURIComponent(name)}`),
    onSuccess: () => {
      onDeselect();
      queryClient.invalidateQueries({ queryKey: ['rules'] });
    },
  });

  const updateStatus = useMutation({
    mutationFn: ({ name, status }: { name: string; status: string }) =>
      patchJson(`/rules/${encodeURIComponent(name)}`, { status }),
    onSuccess: () => onRefresh(),
  });

  return (
    <>
      <div className="panel-head compact">
        <h2>Rule Detail</h2>
        <span className="mono-chip">{rule.name}</span>
      </div>
      <div className="fact-list compact-facts">
        <Fact label="scope" value={rule.scope} />
        <Fact label="severity" value={rule.severity} />
        <Fact label="enforcement" value={rule.enforcementMode} />
        <Fact label="status" value={rule.status} />
        <Fact label="last changed" value={rule.lastChanged ? formatDate(rule.lastChanged) : 'never'} />
        <Fact label="created" value={formatDate(rule.createdAt)} />
        <Fact label="sessions" value={rule.attachedSessions.join(', ') || 'none'} />
        <Fact label="tasks" value={rule.attachedTasks.join(', ') || 'none'} />
      </div>
      {rule.content ? (
        <div className="json-block">
          <strong>Content</strong>
          <pre>{rule.content.slice(0, 2000)}{rule.content.length > 2000 ? '...' : ''}</pre>
        </div>
      ) : null}
      <div className="inline-actions">
        <button
          className="ghost-btn"
          type="button"
          disabled={rule.status === 'active' || updateStatus.isPending}
          onClick={() => updateStatus.mutate({ name: rule.name, status: 'active' })}
        >
          activate
        </button>
        <button
          className="ghost-btn"
          type="button"
          disabled={rule.status === 'inactive' || updateStatus.isPending}
          onClick={() => updateStatus.mutate({ name: rule.name, status: 'inactive' })}
        >
          deactivate
        </button>
        <button
          className="ghost-btn"
          type="button"
          disabled={remove.isPending}
          onClick={() => remove.mutate(rule.name)}
        >
          <Trash2 size={14} /> delete
        </button>
      </div>
    </>
  );
}

function RuleCreate({ onCreated }: { onCreated: (name: string) => void }) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState('project');
  const [severity, setSeverity] = useState('warn');
  const [enforcementMode, setEnforcementMode] = useState('advisory');
  const [status, setStatus] = useState('active');
  const [content, setContent] = useState('');
  const [attachedSessions, setAttachedSessions] = useState('');
  const [attachedTasks, setAttachedTasks] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError('');
    try {
      const created = await postJson<RuleRecordApi>('/rules', {
        name: name.trim(),
        scope,
        severity,
        enforcementMode,
        status,
        content: content.trim() || undefined,
        attachedSessions: attachedSessions.split(',').map(s => s.trim()).filter(Boolean),
        attachedTasks: attachedTasks.split(',').map(s => s.trim()).filter(Boolean),
      });
      setName(''); setContent(''); setAttachedSessions(''); setAttachedTasks('');
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
        <h2>Add Rule</h2>
      </div>
      <form className="stack-form" onSubmit={handleSubmit}>
        <Field label="name">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="no-destructive-ops" />
        </Field>
        <div className="two-col">
          <Field label="scope">
            <select value={scope} onChange={e => setScope(e.target.value)}>
              {SCOPES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="severity">
            <select value={severity} onChange={e => setSeverity(e.target.value)}>
              {SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
        </div>
        <div className="two-col">
          <Field label="enforcement">
            <select value={enforcementMode} onChange={e => setEnforcementMode(e.target.value)}>
              {ENFORCEMENT_MODES.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="status">
            <select value={status} onChange={e => setStatus(e.target.value)}>
              {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
        </div>
        <Field label="content">
          <textarea value={content} onChange={e => setContent(e.target.value)} rows={4} placeholder="Rule definition and enforcement logic..." />
        </Field>
        <Field label="attached sessions (comma-separated ids)">
          <input value={attachedSessions} onChange={e => setAttachedSessions(e.target.value)} placeholder="session-id-1, session-id-2" />
        </Field>
        <Field label="attached tasks (comma-separated ids)">
          <input value={attachedTasks} onChange={e => setAttachedTasks(e.target.value)} placeholder="task-id-1" />
        </Field>
        {error ? <p className="form-error">{error}</p> : null}
        <button className="primary-btn" type="submit" disabled={!name.trim() || busy}>
          <Plus size={14} /> create rule
        </button>
      </form>
    </>
  );
}
