import { useState, useMemo, type ChangeEvent } from 'react';
import { metadataText, providerRoutesFromModels } from '../chat-helpers.js';
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
  Plus,
  Check,
  Pencil,
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
import { ProviderAccountsPanel } from './provider-accounts-panel.js';
import { ProviderCompatPanel } from './provider-compat-panel.js';
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
export function ProvidersPage() {
  const { t } = useI18n();
  const qc = useQueryClient();
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
  const routes = providerRoutesFromModels(modelRoutes.data);

  // ── Add / Edit / Delete mutations ─────────────────────
  const addProvider = useMutation({
    mutationFn: (payload: Record<string, unknown>) => postJson('/providers', payload),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['provider-models'] }); qc.invalidateQueries({ queryKey: ['onboarding'] }); },
  });
  const updateProvider = useMutation({
    mutationFn: ({ name, ...payload }: { name: string } & Record<string, unknown>) =>
      patchJson(`/providers/${encodeURIComponent(name)}`, payload),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['provider-models'] }); qc.invalidateQueries({ queryKey: ['onboarding'] }); },
  });
  const removeProvider = useMutation({
    mutationFn: (name: string) => deleteJson(`/providers/${encodeURIComponent(name)}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['provider-models'] }); qc.invalidateQueries({ queryKey: ['onboarding'] }); },
  });

  // Track which provider is being edited inline, plus edit form state
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [selectedCompatProvider, setSelectedCompatProvider] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{
    model?: string; baseUrl?: string; apiKey?: string; enabled?: boolean; weight?: number;
  }>({});

  function startEdit(name: string, provider: Record<string, unknown>) {
    setEditingProvider(name);
    setEditDraft({
      model: String(provider.model ?? ''),
      baseUrl: String(provider.baseUrl ?? ''),
      apiKey: String(provider.apiKey ?? ''),
      enabled: Boolean(provider.enabled ?? true),
      weight: Number(provider.weight ?? 100),
    });
  }
  function cancelEdit() { setEditingProvider(null); }

  function saveEdit(name: string) {
    updateProvider.mutate({ name, ...editDraft });
    setEditingProvider(null);
  }

  // Build a map of config-level providers (from modelRoutes) for the edit/delete UI
  const configProviders = useMemo(() => {
    const map = new Map<string, { model?: string; baseUrl?: string; enabled?: boolean; hasApiKey?: boolean }>();
    (modelRoutes.data?.providers ?? []).forEach((p: any) => {
      map.set(p.provider, {
        model: p.model,
        baseUrl: p.baseUrl,
        enabled: p.enabled,
        hasApiKey: p.hasApiKey,
      });
    });
    // Augment with discovery-level info
    for (const dp of providers) {
      const dpName = String(dp.name ?? '');
      if (!map.has(dpName) && dp.configuredKey) {
        map.set(dpName, { enabled: Boolean(dp.available) });
      }
    }
    return map;
  }, [modelRoutes.data, providers]);

  return (
    <section className="panel-grid provider-grid">
      <div className="panel">
        <ProviderAccountsPanel />
        <div className="section-divider" />
        <div className="panel-head">
          <div>
            <h2>{t('pages.providers.title')}</h2>
            <p>{t('pages.providers.subtitle')}</p>
          </div>
          <StatusPill status="partial" />
        </div>
        <DataTable
          loading={onboarding.isLoading}
          empty={t('pages.providers.emptyEndpoints')}
          rows={providers}
          renderRow={(provider, index) => {
            const readiness = provider.readiness ?? {};
            const state = providerReadinessLabel(readiness, t);
            const detail = providerReadinessDetail(provider, readiness, t);
            const compatEvidence = Array.isArray(provider.compatibilityEvidence)
              ? provider.compatibilityEvidence
              : provider.compatEvidence?.latest
                ? [provider.compatEvidence.latest]
                : [];
            const latestEvidence = compatEvidence[0];
            const promotionState = metadataText(provider.promotionState);
            const name = metadataText(provider.name) ?? metadataText(provider.provider) ?? `provider-${index + 1}`;
            const cfg = configProviders.get(name);
            const isEditing = editingProvider === name;
            const deleteError = removeProvider.isError && removeProvider.variables === name ? String(removeProvider.error) : null;

            return (
              <div className="record-row provider-row" key={name}>
                <div className="provider-row-main">
                  <span className="row-title">
                    {name}
                    {promotionState === 'verified_advisory' ? <span className="status-text succeeded" title={t('pages.providers.verifiedAdvisory')}> ✓</span> : null}
                    {cfg?.hasApiKey ? <span className="status-text" title={t('pages.providers.apiKeySet')}> 🔑</span> : null}
                  </span>
                  <span>{metadataText(provider.source) ?? t('pages.providers.sourceUnknown')}</span>
                  <span>{metadataText(provider.defaultModel) ?? metadataText(provider.model) ?? t('pages.providers.modelUnknown')}</span>
                  <span className={`status-text ${readiness.ready ? 'succeeded' : readiness.manualSetupRequired ? 'blocked' : 'ready'}`}>{state}</span>
                  <span>{detail}</span>
                  <span className="provider-row-actions">
                    {cfg ? (
                      isEditing ? (
                        <>
                          <button type="button" className="tiny-btn" onClick={() => saveEdit(name)} title={t('common.save')}><Check size={12} /> {t('pages.providers.save')}</button>
                          <button type="button" className="tiny-btn" onClick={cancelEdit} title={t('common.cancel')}><X size={12} /></button>
                        </>
                      ) : (
                        <>
                          <button type="button" className="tiny-btn" onClick={() => startEdit(name, cfg)} title={t('common.edit')}><Pencil size={12} /></button>
                          <button type="button" className="tiny-btn danger" onClick={() => { if (confirm(t('pages.providers.removeConfirm', { name }))) removeProvider.mutate(name); }} title={t('pages.providers.remove')}><Trash2 size={12} /></button>
                          {cfg.enabled !== undefined ? (
                            <button type="button" className="tiny-btn" onClick={() => updateProvider.mutate({ name, enabled: !cfg.enabled })} title={cfg.enabled ? t('pages.providers.disable') : t('pages.providers.enable')}>
                              {cfg.enabled ? '⏻' : '⏼'}
                            </button>
                          ) : null}
                        </>
                      )
                    ) : (
                      <span className="status-text dim">{t('pages.providers.discoveryOnly')}</span>
                    )}
                    <button
                      type="button"
                      className="tiny-btn"
                      onClick={() => setSelectedCompatProvider(name)}
                      title={t('pages.providers.compatRunTitle')}
                    >
                      {t('pages.providers.compatSelect')}
                    </button>
                  </span>
                </div>
                {isEditing && cfg ? (
                  <div className="provider-edit-panel">
                    <div className="provider-edit-grid">
                      <Field label={t('pages.providers.modelField')}><input value={editDraft.model ?? ''} onChange={e => setEditDraft(d => ({ ...d, model: e.target.value }))} placeholder={t('pages.providers.modelIdPlaceholder')} /></Field>
                      <Field label={t('pages.providers.apiKeyField')}><input type="password" value={editDraft.apiKey ?? ''} onChange={e => setEditDraft(d => ({ ...d, apiKey: e.target.value }))} placeholder={t('pages.providers.apiKeyPlaceholder')} /></Field>
                      <Field label={t('pages.providers.baseUrlField')}><input value={editDraft.baseUrl ?? ''} onChange={e => setEditDraft(d => ({ ...d, baseUrl: e.target.value }))} placeholder={t('pages.providers.baseUrlPlaceholder')} /></Field>
                      <div className="provider-edit-meta">
                        <label className="toolbar-toggle provider-toggle">
                          <input type="checkbox" checked={editDraft.enabled ?? true} onChange={e => setEditDraft(d => ({ ...d, enabled: e.target.checked }))} />
                          {t('common.enabled')}
                        </label>
                        <Field label={t('pages.providers.weightField')}><input type="number" min={0} max={1000} value={editDraft.weight ?? 100} onChange={e => setEditDraft(d => ({ ...d, weight: Number(e.target.value) }))} /></Field>
                      </div>
                    </div>
                    {deleteError ? <div className="error-banner">{t('pages.providers.removeError', { error: deleteError })}</div> : null}
                  </div>
                ) : null}
                {compatEvidence.length > 0 ? (
                  <span className="compat-badges">
                    {compatEvidence.map((ce, i) => {
                      const probeId = String(ce.probeId ?? ce.id ?? `probe-${i}`);
                      const decision = String(ce.decision ?? '');
                      const model = ce.model ? String(ce.model) : '';
                      return (
                        <span key={i} className={`compat-badge ${decision === 'required' ? 'required' : 'passed'}`} title={`${probeId}: ${decision}${model ? ` (${model})` : ''}`}>
                          {metadataText(ce.id)?.slice(0, 22) ?? probeId}
                        </span>
                      );
                    })}
                  </span>
                ) : null}
                {latestEvidence ? (
                  <span className="compat-evidence-detail">
                    {t('pages.providers.evidenceDetail', { evidence: metadataText(latestEvidence.id) ?? '?', task: metadataText(latestEvidence.taskRunId) ?? 'none', run: metadataText(latestEvidence.runSpecId) ?? 'none', tokens: String(latestEvidence.totalTokens ?? 0) })}
                  </span>
                ) : readiness.ready ? (
                  <span className="compat-evidence-detail">{t('pages.providers.evidenceNone')} los compat --execute --target {name} --probe read-context</span>
                ) : null}
              </div>
            );
          }}
        />
        {providers.length === 0 && !onboarding.isLoading ? (
          <div className="empty-guide">
            <p>{t('pages.providers.emptyGuidePrefix', { key: 'DEEPSEEK_API_KEY' })} <button type="button" className="link-btn" onClick={() => window.location.hash = 'onboarding'}>{t('nav.onboarding')}</button> {t('pages.providers.emptyGuideSuffix')}</p>
          </div>
        ) : null}
        <div className="section-divider" />
        <div className="panel-head compact">
          <h2>{t('pages.providers.routesTitle')}</h2>
          <StatusPill status="live" />
        </div>
        <DataTable
          loading={modelRoutes.isLoading}
          empty={t('pages.providers.emptyRoutes')}
          rows={routes}
          renderRow={(route) => (
            <div className="record-row route-row">
              <span className="row-title">{route.provider}</span>
              <span>{route.baseUrl ?? t('pages.providers.baseUrlUnknown')}</span>
              <span>{route.model ?? t('pages.providers.modelUnknown')}</span>
              <span>{route.ok ? t('pages.providers.modelsCount', { count: route.count ?? route.models.length }) : route.error ?? t('pages.providers.unavailable')}</span>
              <span>{route.hasApiKey ? t('pages.providers.keySet') : t('pages.providers.noKey')} · {route.source ?? t('pages.providers.manualSource')}</span>
            </div>
          )}
        />
      </div>
      <aside className="panel inspector">
        <ProviderAddForm onAdd={addProvider.mutate} adding={addProvider.isPending} error={addProvider.error ? String(addProvider.error) : null} />
        <div className="section-divider" />
        <div className="panel-head compact"><h2>{t('pages.providers.discoveryTools')}</h2></div>
        <div className="fact-list">
          <Fact label={t('pages.providers.factProviders')} value={String(providers.length)} />
          <Fact label={t('pages.providers.factConfigProviders')} value={String(configProviders.size)} />
          <Fact label={t('pages.providers.factRoutes')} value={String(routes.length)} />
          <Fact label={t('pages.providers.factTools')} value={String(tools.length)} />
          <Fact label={t('pages.providers.factStatus')} value={onboarding.data?.summary ?? t('pages.providers.notLoaded')} />
        </div>
        <div className="definition-list">
          <Definition term={t('pages.providers.defEndpoint')} text={t('pages.providers.defEndpointText')} />
          <Definition term={t('pages.providers.defAccount')} text={t('pages.providers.defAccountText')} />
          <Definition term={t('pages.providers.defModel')} text={t('pages.providers.defModelText')} />
        </div>
        <div className="section-divider" />
        {selectedCompatProvider || providers[0] ? (
          <ProviderCompatPanel
            providerName={selectedCompatProvider ?? String(providers[0]?.name ?? providers[0]?.provider ?? '')}
            model={
              selectedCompatProvider
                ? configProviders.get(selectedCompatProvider)?.model
                : configProviders.get(String(providers[0]?.name ?? providers[0]?.provider ?? ''))?.model
            }
          />
        ) : (
          <EmptyText text={t('pages.providers.compatPickProvider')} />
        )}
      </aside>
    </section>
  );
}

// ── Add Provider Form ────────────────────────────────────

type ProviderAddPayload = {
  name: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  enabled?: boolean;
  weight?: number;
  apiShape?: string;
};

function ProviderAddForm({ onAdd, adding, error }: { onAdd: (p: Record<string, unknown>) => void; adding: boolean; error: string | null }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [weight, setWeight] = useState(100);

  function submit() {
    const payload: Record<string, unknown> = { name: name.trim() };
    const key = apiKey.trim(); if (key) payload.apiKey = key;
    const url = baseUrl.trim(); if (url) payload.baseUrl = url;
    const m = model.trim(); if (m) payload.model = m;
    payload.enabled = enabled;
    payload.weight = weight;
    onAdd(payload);
    // Reset form on success (clears after next render if mutation succeeds)
    setName(''); setApiKey(''); setBaseUrl(''); setModel(''); setEnabled(true); setWeight(100);
  }

  const canSubmit = name.trim().length > 0 && !adding;

  return (
    <div className="provider-config-workspace">
      <div className="panel-head compact">
        <h2>{t('pages.providers.addTitle')}</h2>
        <StatusPill status="partial" />
      </div>
      <Field label={t('pages.providers.providerIdField')}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder={t('pages.providers.namePlaceholder')} onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
      </Field>
      <Field label={t('pages.providers.apiKeyField')}>
        <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={t('pages.providers.apiKeyPlaceholder')} onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
      </Field>
      <Field label={t('pages.providers.baseUrlField')}>
        <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder={t('pages.providers.baseUrlFullPlaceholder')} onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
      </Field>
      <Field label={t('pages.providers.defaultModelField')}>
        <input value={model} onChange={e => setModel(e.target.value)} placeholder={t('pages.providers.modelIdPlaceholder')} onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
      </Field>
      <Field label={t('pages.providers.weightField')}>
        <input type="number" min={0} max={1000} value={weight} onChange={e => setWeight(Number(e.target.value))} />
      </Field>
      <label className="toolbar-toggle provider-toggle">
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        {t('common.enabled')}
      </label>
      <button type="button" className="btn" disabled={!canSubmit} onClick={submit}>
        <Plus size={14} /> {adding ? t('pages.providers.adding') : t('pages.providers.add')}
      </button>
      {error ? <div className="error-banner">{error}</div> : null}
    </div>
  );
}

// ── Helpers (unchanged) ──────────────────────────────────

function providerReadinessLabel(readiness: ProviderReadiness, t: (key: string) => string): string {
  if (readiness.ready) return t('pages.status.ready');
  if (readiness.manualSetupRequired) return t('pages.providers.manualSetup');
  if (readiness.discovered) return t('pages.providers.discovered');
  return t('common.unknown');
}

function providerReadinessDetail(provider: ProviderDiscoveryProvider, readiness: ProviderReadiness, t: (key: string) => string): string {
  const blocker = metadataText(readiness.blocker);
  if (blocker) return blocker;
  if (readiness.configuredKey !== undefined) {
    return readiness.configuredKey ? t('pages.providers.configuredKey') : t('pages.providers.noConfiguredKey');
  }
  if (provider.hasApiKey !== undefined) {
    return provider.hasApiKey ? t('pages.providers.configuredKey') : t('pages.providers.noConfiguredKey');
  }
  return t('pages.providers.readinessUnknown');
}
