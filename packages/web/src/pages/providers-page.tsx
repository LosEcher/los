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

  return (
    <section className="panel-grid provider-grid">
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Provider Endpoints</h2>
            <p>Read-only discovery surface. Provider lifecycle edits are deferred until stable APIs exist.</p>
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
            return (
              <div className="record-row provider-row">
                <span className="row-title">
                  {metadataText(provider.name) ?? metadataText(provider.provider) ?? `provider-${index + 1}`}
                  {promotionState === 'verified_advisory' ? <span className="status-text succeeded" title="Verified advisory"> ✓</span> : null}
                </span>
                <span>{metadataText(provider.source) ?? 'source?'}</span>
                <span>{metadataText(provider.defaultModel) ?? metadataText(provider.model) ?? 'model?'}</span>
                <span className={`status-text ${readiness.ready ? 'succeeded' : readiness.manualSetupRequired ? 'blocked' : 'ready'}`}>{state}</span>
                <span>{detail}</span>
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
                  <span className="compat-evidence-detail">evidence none · run los compat --execute --target {metadataText(provider.name) ?? metadataText(provider.provider) ?? 'provider'} --probe read-context</span>
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
        <ProviderConfigWorkspace />
        <div className="section-divider" />
        <div className="panel-head compact"><h2>Discovery Tools</h2></div>
        <div className="fact-list">
          <Fact label="providers" value={String(providers.length)} />
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

type ProviderConfigDraft = {
  providerId: string;
  apiKeyEnv: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
};

function ProviderConfigWorkspace() {
  const [draft, setDraft] = useState<ProviderConfigDraft>({
    providerId: 'deepseek',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    enabled: true,
  });
  const [copied, setCopied] = useState<'env' | 'yaml' | null>(null);
  const envSnippet = buildProviderEnvSnippet(draft);
  const yamlSnippet = buildProviderYamlSnippet(draft);

  async function copySnippet(kind: 'env' | 'yaml', text: string) {
    await navigator.clipboard?.writeText(text);
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1600);
  }

  function setProviderId(value: string) {
    const providerId = value.trim();
    setDraft(prev => ({
      ...prev,
      providerId,
      apiKeyEnv: providerId ? `${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY` : prev.apiKeyEnv,
    }));
  }

  return (
    <div className="provider-config-workspace">
      <div className="panel-head compact">
        <h2>Provider Settings</h2>
        <StatusPill status="partial" />
      </div>
      <Field label="provider id">
        <input value={draft.providerId} onChange={event => setProviderId(event.target.value)} placeholder="deepseek" />
      </Field>
      <Field label="api key env">
        <input value={draft.apiKeyEnv} onChange={event => setDraft(prev => ({ ...prev, apiKeyEnv: event.target.value }))} placeholder="DEEPSEEK_API_KEY" />
      </Field>
      <Field label="base url">
        <input value={draft.baseUrl} onChange={event => setDraft(prev => ({ ...prev, baseUrl: event.target.value }))} placeholder="https://api.deepseek.com" />
      </Field>
      <Field label="default model">
        <input value={draft.model} onChange={event => setDraft(prev => ({ ...prev, model: event.target.value }))} placeholder="deepseek-v4-flash" />
      </Field>
      <label className="toolbar-toggle provider-toggle">
        <input type="checkbox" checked={draft.enabled} onChange={event => setDraft(prev => ({ ...prev, enabled: event.target.checked }))} />
        enabled
      </label>
      <ConfigSnippet
        title=".env"
        value={envSnippet}
        copied={copied === 'env'}
        onCopy={() => copySnippet('env', envSnippet)}
      />
      <ConfigSnippet
        title="~/.los/config.yaml"
        value={yamlSnippet}
        copied={copied === 'yaml'}
        onCopy={() => copySnippet('yaml', yamlSnippet)}
      />
    </div>
  );
}

function ConfigSnippet({
  title,
  value,
  copied,
  onCopy,
}: {
  title: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="config-note">
      <div className="snippet-head">
        <strong>{title}</strong>
        <button className="tiny-btn" type="button" onClick={onCopy}>
          <Copy size={12} /> {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <code>{value}</code>
    </div>
  );
}

function buildProviderEnvSnippet(draft: ProviderConfigDraft): string {
  const prefix = envPrefixForProvider(draft.providerId);
  const apiKeyEnv = normalizeEnvName(draft.apiKeyEnv) || `${prefix}_API_KEY`;
  return [
    `${apiKeyEnv}=...`,
    `${prefix}_BASE_URL=${draft.baseUrl.trim() || 'https://api.example.com/v1'}`,
    `${prefix}_MODEL=${draft.model.trim() || 'model-id'}`,
  ].join('\n');
}

function buildProviderYamlSnippet(draft: ProviderConfigDraft): string {
  const providerId = sanitizeProviderId(draft.providerId) || 'provider';
  const apiKeyEnv = normalizeEnvName(draft.apiKeyEnv) || `${envPrefixForProvider(providerId)}_API_KEY`;
  const baseUrl = draft.baseUrl.trim() || 'https://api.example.com/v1';
  const model = draft.model.trim() || 'model-id';
  return [
    'providers:',
    `  ${providerId}:`,
    `    apiKey: "\${${apiKeyEnv}}"`,
    `    baseUrl: "${baseUrl}"`,
    `    model: "${model}"`,
    `    enabled: ${draft.enabled ? 'true' : 'false'}`,
  ].join('\n');
}

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

function envPrefixForProvider(providerId: string): string {
  return (sanitizeProviderId(providerId) || 'provider').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function normalizeEnvName(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
}

function sanitizeProviderId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}
