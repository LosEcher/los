import { type FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plus, Shield, Trash2, Upload } from 'lucide-react';
import { deleteJson, getJson, patchJson, postJson } from './api';
import { DataTable, EmptyText, Fact, Field, formatDate, StatusPill } from './ui';
import { useI18n } from './i18n';

const RULE_SCOPES = ['', 'global', 'project'] as const;
const SEVERITIES = ['info', 'warn', 'error', 'block'] as const;
const ENFORCEMENT_MODES = ['advisory', 'required'] as const;
const STATUSES = ['active', 'inactive', 'draft'] as const;

interface RuleRecordApi {
  id: string;
  name: string;
  severity: string;
  enforcementMode: string;
  status: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

type T = ReturnType<typeof useI18n>['t'];

export function RulesPage() {
  const queryClient = useQueryClient();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [scopeFilter, setScopeFilter] = useState('');
  const { t } = useI18n();

  const query = new URLSearchParams();
  if (scopeFilter) query.set('scope', scopeFilter);

  const rules = useQuery({
    queryKey: ['rules', scopeFilter],
    queryFn: () => getJson<RuleRecordApi[]>(`/rules?${query.toString()}`),
    refetchInterval: 15_000,
  });
  const workspace = useQuery({
    queryKey: ['workspace'],
    queryFn: () => getJson<{ workspaceRoot: string }>('/workspace'),
    staleTime: 60_000,
  });

  const list = rules.data ?? [];
  const selected = list.find(r => ruleKey(r) === selectedKey) ?? null;

  const syncToDir = useMutation({
    mutationFn: (scope: string) => postJson('/rules/sync-to-dir', {
      scope: scope || 'global',
      workspaceRoot: workspace.data?.workspaceRoot,
    }),
    onSuccess: (data: any) => alert(t('assets.rules.syncedAlert', { count: data.count, scope: data.scope })),
  });

  const loadFromDir = useMutation({
    mutationFn: (scope: string) => postJson('/rules/load-from-dir', {
      scope: scope || 'global',
      workspaceRoot: workspace.data?.workspaceRoot,
    }),
    onSuccess: (data: any) => {
      alert(t('assets.rules.loadedAlert', { count: data.count, scope: data.scope }));
      queryClient.invalidateQueries({ queryKey: ['rules'] });
    },
  });

  return (
    <section className="panel-grid detail-grid">
      <div className="panel">
        <div className="panel-head">
          <div className="title-row">
            <Shield size={18} />
            <div>
              <h2>{t('assets.rules.title')}</h2>
              <p>{t('assets.rules.subtitle')}</p>
            </div>
          </div>
          <StatusPill status="live" />
          <div className="toolbar">
            <select value={scopeFilter} onChange={e => setScopeFilter(e.target.value)}>
              <option value="">{t('assets.rules.allScopes')}</option>
              {RULE_SCOPES.filter(Boolean).map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <button className="ghost-btn" type="button" disabled={syncToDir.isPending} onClick={() => syncToDir.mutate(scopeFilter)}>
              <Download size={14} /> {t('assets.rules.sync')}
            </button>
            <button className="ghost-btn" type="button" disabled={loadFromDir.isPending} onClick={() => loadFromDir.mutate(scopeFilter)}>
              <Upload size={14} /> {t('assets.rules.import')}
            </button>
          </div>
        </div>
        <DataTable
          loading={rules.isLoading}
          empty={t('assets.rules.emptyList')}
          rows={list}
          renderRow={rule => (
            <button
              type="button"
              className="record-row"
              data-active={selected ? ruleKey(selected) === ruleKey(rule) : false}
              onClick={() => setSelectedKey(ruleKey(rule))}
            >
              <span className="row-title">{rule.name}</span>
              <span>{ruleScopeLabel(rule.metadata, t)}</span>
              <span className={`severity-text ${rule.severity}`}>{rule.severity}</span>
              <span>{rule.enforcementMode}</span>
              <span className={`status-text ${rule.status}`}>{rule.status}</span>
              <span>{formatDate(rule.updatedAt)}</span>
            </button>
          )}
        />
        {list.length === 0 && !rules.isLoading ? (
          <div className="empty-guide">
            <p>{t('assets.rules.emptyGuidePre')} <code>.md</code> {t('assets.rules.emptyGuidePost')}</p>
          </div>
        ) : null}
      </div>

      <aside className="panel inspector">
        {selected ? (
          <RuleInspector
            rule={selected}
            onRefresh={() => queryClient.invalidateQueries({ queryKey: ['rules'] })}
            onDeselect={() => setSelectedKey(null)}
          />
        ) : (
          <RuleCreate
            onCreated={(rule) => {
              setSelectedKey(ruleKey(rule));
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
  const { t } = useI18n();

  const remove = useMutation({
    mutationFn: (rule: RuleRecordApi) => deleteJson(`/rules/${encodeURIComponent(rule.name)}?scope=${encodeURIComponent(ruleScopeValue(rule.metadata))}`),
    onSuccess: () => {
      onDeselect();
      queryClient.invalidateQueries({ queryKey: ['rules'] });
    },
  });

  const updateStatus = useMutation({
    mutationFn: ({ name, status }: { name: string; status: string }) =>
      patchJson(`/rules/${encodeURIComponent(rule.name)}?scope=${encodeURIComponent(ruleScopeValue(rule.metadata))}`, { status }),
    onSuccess: () => onRefresh(),
  });

  return (
    <>
      <div className="panel-head compact">
        <h2>{t('assets.rules.detailTitle')}</h2>
        <span className="mono-chip">{rule.name}</span>
      </div>
      <div className="fact-list compact-facts">
        <Fact label={t('assets.label.scope')} value={ruleScopeLabel(rule.metadata, t)} />
        <Fact label={t('assets.label.layer')} value={ruleLayerLabel(rule.metadata, t)} />
        <Fact label={t('assets.label.severity')} value={rule.severity} />
        <Fact label={t('assets.label.enforcement')} value={rule.enforcementMode} />
        <Fact label={t('assets.label.status')} value={rule.status} />
        <Fact label={t('assets.label.created')} value={formatDate(rule.createdAt)} />
      </div>
      {rule.content ? (
        <div className="json-block">
          <strong>{t('assets.label.content')}</strong>
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
          {t('assets.rules.activate')}
        </button>
        <button
          className="ghost-btn"
          type="button"
          disabled={rule.status === 'inactive' || updateStatus.isPending}
          onClick={() => updateStatus.mutate({ name: rule.name, status: 'inactive' })}
        >
          {t('assets.rules.deactivate')}
        </button>
        <button
          className="ghost-btn"
          type="button"
          disabled={remove.isPending}
          onClick={() => remove.mutate(rule)}
        >
          <Trash2 size={14} /> {t('common.delete')}
        </button>
      </div>
    </>
  );
}

function RuleCreate({ onCreated }: { onCreated: (rule: RuleRecordApi) => void }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [scope, setScope] = useState('project');
  const [severity, setSeverity] = useState('warn');
  const [enforcementMode, setEnforcementMode] = useState('advisory');
  const [status, setStatus] = useState('active');
  const [content, setContent] = useState('');
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
      });
      setName(''); setContent('');
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
        <h2>{t('assets.rules.addTitle')}</h2>
      </div>
      <form className="stack-form" onSubmit={handleSubmit}>
        <Field label={t('assets.label.name')}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="no-destructive-ops" />
        </Field>
        <Field label={t('assets.label.scope')}>
          <select value={scope} onChange={e => setScope(e.target.value)}>
            <option value="global">{t('assets.rules.optionGlobal')}</option>
            <option value="project">{t('assets.rules.optionProject')}</option>
          </select>
        </Field>
        <div className="two-col">
          <Field label={t('assets.label.severity')}>
            <select value={severity} onChange={e => setSeverity(e.target.value)}>
              {SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label={t('assets.label.enforcement')}>
            <select value={enforcementMode} onChange={e => setEnforcementMode(e.target.value)}>
              {ENFORCEMENT_MODES.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
        </div>
        <Field label={t('assets.label.status')}>
          <select value={status} onChange={e => setStatus(e.target.value)}>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label={t('assets.label.content')}>
          <textarea value={content} onChange={e => setContent(e.target.value)} rows={4} placeholder={t('assets.rules.contentPh')} />
        </Field>
        {error ? <p className="form-error">{error}</p> : null}
        <button className="primary-btn" type="submit" disabled={!name.trim() || busy}>
          <Plus size={14} /> {t('assets.rules.createRule')}
        </button>
      </form>
    </>
  );
}

function ruleScopeLabel(metadata: Record<string, unknown>, t: T): string {
  const scope = metadata.scope;
  const layer = metadata.ruleLayer;
  if (typeof scope === 'string') return typeof layer === 'string' ? `${scope}/${layer}` : scope;
  return typeof layer === 'string' ? t('assets.skills.scopeUnknownLayer', { layer }) : t('assets.state.unspecified');
}

function ruleLayerLabel(metadata: Record<string, unknown>, t: T): string {
  return typeof metadata.ruleLayer === 'string' ? metadata.ruleLayer : t('assets.state.unspecified');
}

function ruleScopeValue(metadata: Record<string, unknown>): string {
  return typeof metadata.scope === 'string' ? metadata.scope : 'project';
}

function ruleKey(rule: RuleRecordApi): string {
  return `${ruleScopeValue(rule.metadata)}:${rule.name}`;
}
