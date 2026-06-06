import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Copy,
  Database,
  Search,
  Send,
  Trash2,
} from 'lucide-react';
import {
  deleteJson,
  getJson,
  postJson,
  type MemoryResponse,
  type MemoryStats,
  type ProviderDiscovery,
  type ProviderDiscoveryProvider,
  type ProviderModelsResponse,
  type ProviderReadiness,
  type SessionDetail,
  type SessionEventsResponse,
  type SessionObservability,
  type SessionSummary,
  type TaskRun,
} from './api';
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
} from './ui';

export function SessionsPage({
  selectedSessionId,
  onSelectSession,
  onContinueSession,
}: {
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
  onContinueSession: (id: string) => void;
}) {
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => getJson<SessionSummary[]>('/sessions'),
    refetchInterval: 12_000,
  });

  return (
    <section className="panel-grid detail-grid">
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Sessions</h2>
            <p>Read-only persisted run list.</p>
          </div>
          <RefreshQueryButton queryKey={['sessions']} />
        </div>
        <DataTable
          loading={sessions.isLoading}
          empty="No sessions found."
          rows={sessions.data ?? []}
          renderRow={session => (
            <button
              type="button"
              className="record-row session-row"
              data-active={selectedSessionId === session.id}
              onClick={() => onSelectSession(session.id)}
            >
              <span className="row-title">{session.id}</span>
              <span>{formatDate(session.updatedAt)}</span>
              <span>{metadataText(session.metadata.provider) ?? 'provider?'}</span>
              <span>{metadataText(session.metadata.model) ?? 'model?'}</span>
              <span>{metadataText(session.metadata.toolMode) ?? 'mode?'}</span>
            </button>
          )}
        />
      </div>
      <SessionInspector sessionId={selectedSessionId} onContinueSession={onContinueSession} />
    </section>
  );
}

function SessionInspector({
  sessionId,
  onContinueSession,
}: {
  sessionId: string | null;
  onContinueSession: (id: string) => void;
}) {
  const detail = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => getJson<SessionDetail>(`/sessions/${sessionId}`),
    enabled: Boolean(sessionId),
  });
  const events = useQuery({
    queryKey: ['session-events', sessionId],
    queryFn: () => getJson<SessionEventsResponse>(`/sessions/${sessionId}/events?limit=300`),
    enabled: Boolean(sessionId),
  });
  const observability = useQuery({
    queryKey: ['session-observability', sessionId],
    queryFn: () => getJson<SessionObservability>(`/sessions/${sessionId}/observability`),
    enabled: Boolean(sessionId),
  });

  if (!sessionId) {
    return <div className="panel inspector"><EmptyText text="Select a session to inspect events and observability." /></div>;
  }

  return (
    <aside className="panel inspector">
      <div className="panel-head compact">
        <h2>Session Detail</h2>
        <button className="ghost-btn" type="button" onClick={() => onContinueSession(sessionId)}>
          <Send size={14} /> continue
        </button>
      </div>
      <span className="mono-chip">{sessionId}</span>
      {detail.isLoading ? <EmptyText text="Loading session..." /> : null}
      {detail.data ? (
        <div className="fact-list compact-facts">
          <Fact label="provider" value={metadataText(detail.data.metadata.provider) ?? 'default'} />
          <Fact label="model" value={metadataText(detail.data.metadata.model) ?? 'default'} />
          <Fact label="tool mode" value={metadataText(detail.data.metadata.toolMode) ?? 'unknown'} />
          <Fact label="workspace" value={metadataText(detail.data.metadata.workspaceRoot) ?? 'default'} />
          <Fact label="task" value={metadataText(detail.data.metadata.taskRunId) ?? 'none'} />
        </div>
      ) : null}
      {observability.data ? (
        <div className="fact-list">
          <Fact label="events" value={String(observability.data.eventCount)} />
          <Fact label="turns" value={String(observability.data.turnCount)} />
          <Fact label="tokens" value={String(observability.data.totalUsage.totalTokens)} />
          <Fact label="tools" value={observability.data.tools.names.join(', ') || observability.data.tools.status} />
          <Fact label="models" value={observability.data.models.names.join(', ') || observability.data.models.status} />
        </div>
      ) : null}
      {detail.data ? (
        <div className="definition-list compact-definition-list">
          <Definition term="created" text={formatDate(detail.data.createdAt)} />
          <Definition term="updated" text={formatDate(detail.data.updatedAt)} />
          <Definition term="turns" text={String(detail.data.turns.length)} />
          <Definition term="messages" text={String(detail.data.messages.length)} />
        </div>
      ) : null}
      <div className="event-timeline">
        {(events.data?.events ?? []).slice(-80).map(event => (
          <div className="event-line" key={event.id}>
            <span>{formatTime(event.createdAt)}</span>
            <strong>{event.type}</strong>
            <em>{event.toolName ?? event.model ?? event.source}</em>
          </div>
        ))}
      </div>
    </aside>
  );
}

export function TasksPage({ onSelectSession }: { onSelectSession: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const tasks = useQuery({
    queryKey: ['tasks'],
    queryFn: () => getJson<TaskRun[]>('/tasks'),
    refetchInterval: 8_000,
  });
  const selectedTask = (tasks.data ?? []).find(task => task.id === selectedTaskId) ?? null;
  const cancel = useMutation({
    mutationFn: (id: string) => postJson(`/tasks/${id}/cancel`, { reason: 'cancelled_from_tasks_page' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tasks'] }),
  });

  return (
    <section className="panel-grid detail-grid">
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Tasks</h2>
            <p>Scheduler records above chat sessions. Cancel is available only for active tasks.</p>
          </div>
          <RefreshQueryButton queryKey={['tasks']} />
        </div>
        <DataTable
          loading={tasks.isLoading}
          empty="No tasks yet."
          rows={tasks.data ?? []}
          renderRow={task => (
            <div className="record-row task-row" data-active={selectedTaskId === task.id}>
              <div className="task-main">
                <button type="button" className="link-cell" onClick={() => onSelectSession(task.sessionId)}>
                  {task.id}
                </button>
                <span>{task.promptPreview}</span>
              </div>
              <span className={`status-text ${task.status}`}>{task.status}</span>
              <span>{task.toolMode}</span>
              <span>{task.provider ?? 'default'} / {task.model ?? 'model?'}</span>
              <span>{task.nodeId ?? 'local'}</span>
              <span>{formatDate(task.updatedAt)}</span>
              <button className="tiny-btn" type="button" onClick={() => setSelectedTaskId(task.id)}>
                <Search size={12} /> inspect
              </button>
              <button className="tiny-btn" type="button" disabled={!['queued', 'running'].includes(task.status) || cancel.isPending} onClick={() => cancel.mutate(task.id)}>
                cancel
              </button>
            </div>
          )}
        />
      </div>
      <TaskRunInspector task={selectedTask} />
    </section>
  );
}

function TaskRunInspector({ task }: { task: TaskRun | null }) {
  const inspect = useMutation({
    mutationFn: (runSpecId: string) => getJson(`/runs/${runSpecId}/inspect`),
  });
  const recover = useMutation({
    mutationFn: (runSpecId: string) => postJson(`/runs/${runSpecId}/recover`, {}),
  });
  const verify = useMutation({
    mutationFn: (runSpecId: string) => postJson(`/runs/${runSpecId}/verify`, {}),
  });
  const runSpecId = task?.runSpecId;
  const latestResult = verify.data ?? recover.data ?? inspect.data;

  if (!task) {
    return <aside className="panel inspector"><EmptyText text="Select a task to inspect run evidence and recovery state." /></aside>;
  }

  return (
    <aside className="panel inspector">
      <div className="panel-head compact">
        <h2>Task Run</h2>
        <span className={`status-text ${task.status}`}>{task.status}</span>
      </div>
      <span className="mono-chip">{task.id}</span>
      <div className="fact-list compact-facts">
        <Fact label="run spec" value={runSpecId ?? 'none'} />
        <Fact label="session" value={task.sessionId} />
        <Fact label="trace" value={task.traceId} />
        <Fact label="attempt" value={String(task.attempt)} />
        <Fact label="node" value={task.nodeId ?? 'local'} />
      </div>
      <div className="inline-actions">
        <button className="ghost-btn" type="button" disabled={!runSpecId || inspect.isPending} onClick={() => runSpecId && inspect.mutate(runSpecId)}>
          <Search size={14} /> inspect
        </button>
        <button className="ghost-btn" type="button" disabled={!runSpecId || recover.isPending} onClick={() => runSpecId && recover.mutate(runSpecId)}>
          <Database size={14} /> recover
        </button>
        <button className="ghost-btn" type="button" disabled={!runSpecId || verify.isPending} onClick={() => runSpecId && verify.mutate(runSpecId)}>
          <Send size={14} /> verify
        </button>
      </div>
      {latestResult ? (
        <div className="json-block">
          <strong>Run Operation Result</strong>
          <pre>{JSON.stringify(latestResult, null, 2)}</pre>
        </div>
      ) : (
        <EmptyText text={runSpecId ? 'No run operation loaded.' : 'Task has no run spec link.'} />
      )}
    </aside>
  );
}

export function MemoryPage() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const memory = useQuery({
    queryKey: ['memory', query],
    queryFn: () => getJson<MemoryResponse>(`/memory?limit=80&q=${encodeURIComponent(query)}`),
  });
  const stats = useQuery({
    queryKey: ['memory-stats'],
    queryFn: () => getJson<MemoryStats>('/memory/stats'),
  });
  const add = useMutation({
    mutationFn: () => postJson('/memory', {
      title,
      summary,
      kind: 'note',
      tags: ['web-console'],
      source: 'user',
    }),
    onSuccess: async () => {
      setTitle('');
      setSummary('');
      await queryClient.invalidateQueries({ queryKey: ['memory'] });
      await queryClient.invalidateQueries({ queryKey: ['memory-stats'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => deleteJson(`/memory/${id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['memory'] });
      await queryClient.invalidateQueries({ queryKey: ['memory-stats'] });
    },
  });

  return (
    <section className="panel-grid memory-grid">
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Memory</h2>
            <p>Read/write observations with source and session linkage.</p>
          </div>
          <div className="search-box">
            <Search size={14} />
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="search memory" />
          </div>
        </div>
        <div className="memory-list">
          {memory.isLoading ? <EmptyText text="Loading memory..." /> : null}
          {(memory.data?.results ?? []).map(obs => (
            <article className="memory-row" key={obs.id}>
              <div>
                <h3>{obs.title}</h3>
                <p>{obs.summary || 'No summary'}</p>
                <span>{obs.kind} · {obs.source} · {formatDate(obs.updatedAt)}</span>
              </div>
              <button className="icon-btn danger" type="button" onClick={() => remove.mutate(obs.id)} title="delete memory">
                <Trash2 size={14} />
              </button>
            </article>
          ))}
        </div>
      </div>
      <aside className="panel inspector">
        <div className="panel-head compact">
          <h2>Add Observation</h2>
        </div>
        <form className="stack-form" onSubmit={(event) => { event.preventDefault(); if (title.trim()) add.mutate(); }}>
          <Field label="title">
            <input value={title} onChange={event => setTitle(event.target.value)} placeholder="short memory title" />
          </Field>
          <Field label="summary">
            <textarea value={summary} onChange={event => setSummary(event.target.value)} rows={5} placeholder="what should future runs know?" />
          </Field>
          <button className="primary-btn" type="submit" disabled={!title.trim() || add.isPending}>
            <Database size={14} /> save
          </button>
        </form>
        <div className="fact-list">
          <Fact label="total" value={String(stats.data?.totalObservations ?? 0)} />
          <Fact label="kinds" value={Object.keys(stats.data?.byKind ?? {}).join(', ') || 'none'} />
          <Fact label="sources" value={Object.keys(stats.data?.bySource ?? {}).join(', ') || 'none'} />
        </div>
      </aside>
    </section>
  );
}

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
  const routes = modelRoutes.data?.providers ?? [];

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
            return (
              <div className="record-row provider-row">
                <span className="row-title">{metadataText(provider.name) ?? metadataText(provider.provider) ?? `provider-${index + 1}`}</span>
                <span>{metadataText(provider.source) ?? 'source?'}</span>
                <span>{metadataText(provider.defaultModel) ?? metadataText(provider.model) ?? 'model?'}</span>
                <span className={`status-text ${readiness.ready ? 'succeeded' : readiness.manualSetupRequired ? 'blocked' : 'ready'}`}>{state}</span>
                <span>{detail}</span>
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

function metadataText(value: unknown): string | null {
  if (typeof value === 'string') {
    const text = value.trim();
    return text || null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}
