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
        <div className="panel-head">
          <div>
            <h2>Provider Endpoints</h2>
            <p>Manage provider configs: add, edit, enable/disable, or remove.</p>
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
            const compatEvidence = Array.isArray(provider.compatibilityEvidence)
              ? provider.compatibilityEvidence as Array<Record<string, unknown>>
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
                    {promotionState === 'verified_advisory' ? <span className="status-text succeeded" title="Verified advisory"> ✓</span> : null}
                    {cfg?.hasApiKey ? <span className="status-text" title="API key set"> 🔑</span> : null}
                  </span>
                  <span>{metadataText(provider.source) ?? 'source?'}</span>
                  <span>{metadataText(provider.defaultModel) ?? metadataText(provider.model) ?? 'model?'}</span>
                  <span className={`status-text ${readiness.ready ? 'succeeded' : readiness.manualSetupRequired ? 'blocked' : 'ready'}`}>{state}</span>
                  <span>{detail}</span>
                  <span className="provider-row-actions">
                    {cfg ? (
                      isEditing ? (
                        <>
                          <button type="button" className="tiny-btn" onClick={() => saveEdit(name)} title="Save"><Check size={12} /> save</button>
                          <button type="button" className="tiny-btn" onClick={cancelEdit} title="Cancel"><X size={12} /></button>
                        </>
                      ) : (
                        <>
                          <button type="button" className="tiny-btn" onClick={() => startEdit(name, cfg)} title="Edit"><Pencil size={12} /></button>
                          <button type="button" className="tiny-btn danger" onClick={() => { if (confirm(`Remove provider "${name}"?`)) removeProvider.mutate(name); }} title="Remove"><Trash2 size={12} /></button>
                          {cfg.enabled !== undefined ? (
                            <button type="button" className="tiny-btn" onClick={() => updateProvider.mutate({ name, enabled: !cfg.enabled })} title={cfg.enabled ? 'Disable' : 'Enable'}>
                              {cfg.enabled ? '⏻' : '⏼'}
                            </button>
                          ) : null}
                        </>
                      )
                    ) : (
                      <span className="status-text dim">discovery-only</span>
                    )}
                  </span>
                </div>
                {isEditing && cfg ? (
                  <div className="provider-edit-panel">
                    <div className="provider-edit-grid">
                      <Field label="model"><input value={editDraft.model ?? ''} onChange={e => setEditDraft(d => ({ ...d, model: e.target.value }))} placeholder="model-id" /></Field>
                      <Field label="api key"><input type="password" value={editDraft.apiKey ?? ''} onChange={e => setEditDraft(d => ({ ...d, apiKey: e.target.value }))} placeholder="sk-…" /></Field>
                      <Field label="base url"><input value={editDraft.baseUrl ?? ''} onChange={e => setEditDraft(d => ({ ...d, baseUrl: e.target.value }))} placeholder="https://…" /></Field>
                      <div className="provider-edit-meta">
                        <label className="toolbar-toggle provider-toggle">
                          <input type="checkbox" checked={editDraft.enabled ?? true} onChange={e => setEditDraft(d => ({ ...d, enabled: e.target.checked }))} />
                          enabled
                        </label>
                        <Field label="weight"><input type="number" min={0} max={1000} value={editDraft.weight ?? 100} onChange={e => setEditDraft(d => ({ ...d, weight: Number(e.target.value) }))} /></Field>
                      </div>
                    </div>
                    {deleteError ? <div className="error-banner">Error removing: {deleteError}</div> : null}
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
                    evidence {metadataText(latestEvidence.id) ?? '?'} · task {metadataText(latestEvidence.taskRunId) ?? 'none'} · run {metadataText(latestEvidence.runSpecId) ?? 'none'} · tokens {String(latestEvidence.totalTokens ?? 0)}
                  </span>
                ) : readiness.ready ? (
                  <span className="compat-evidence-detail">evidence none · run los compat --execute --target {name} --probe read-context</span>
                ) : null}
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
        <ProviderAddForm onAdd={addProvider.mutate} adding={addProvider.isPending} error={addProvider.error ? String(addProvider.error) : null} />
        <div className="section-divider" />
        <div className="panel-head compact"><h2>Discovery Tools</h2></div>
        <div className="fact-list">
          <Fact label="providers" value={String(providers.length)} />
          <Fact label="config providers" value={String(configProviders.size)} />
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
        <h2>Add Provider</h2>
        <StatusPill status="partial" />
      </div>
      <Field label="provider id *">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="my-provider" onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
      </Field>
      <Field label="api key">
        <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-…" onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
      </Field>
      <Field label="base url">
        <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
      </Field>
      <Field label="default model">
        <input value={model} onChange={e => setModel(e.target.value)} placeholder="model-id" onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
      </Field>
      <Field label="weight">
        <input type="number" min={0} max={1000} value={weight} onChange={e => setWeight(Number(e.target.value))} />
      </Field>
      <label className="toolbar-toggle provider-toggle">
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        enabled
      </label>
      <button type="button" className="btn" disabled={!canSubmit} onClick={submit}>
        <Plus size={14} /> {adding ? 'Adding…' : 'Add Provider'}
      </button>
      {error ? <div className="error-banner">{error}</div> : null}
    </div>
  );
}

// ── Helpers (unchanged) ──────────────────────────────────

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
