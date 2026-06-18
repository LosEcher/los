import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, Save } from 'lucide-react';
import {
  getJson,
  deleteJson,
  patchJson,
  type Health,
  type ProjectListResponse,
} from '../api/index.js';
import {
  Field,
  Fact,
  formatDuration,
  StatusPill,
  EmptyText,
} from '../ui.js';

type Cfg = Record<string, Record<string, unknown>>;

// ── Section save hook ─────────────────────────────────────

function useSaveSection(queryClient: ReturnType<typeof useQueryClient>) {
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => patchJson('/settings', body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  });
}

// ── Reusable field editors ─────────────────────────────────

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <input type="text" value={value} onChange={e => onChange(e.target.value)} />
    </Field>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <Field label={label}>
      <input type="number" value={value} onChange={e => onChange(Number(e.target.value))} />
    </Field>
  );
}

function ToggleField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <Field label={label}>
      <label className="toolbar-toggle">
        <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
        {checked ? 'enabled' : 'disabled'}
      </label>
    </Field>
  );
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <select value={value} onChange={e => onChange(e.target.value)}>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </Field>
  );
}

function SectionHeader({ title, onSave, saving }: { title: string; onSave?: () => void; saving?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '12px 0 6px' }}>
      <strong>{title}</strong>
      {onSave ? (
        <button type="button" className="ghost-btn" onClick={onSave} disabled={saving}>
          <Save size={13} /> {saving ? 'saving...' : 'save'}
        </button>
      ) : null}
    </div>
  );
}

// ── Main component ────────────────────────────────────────

export function SettingsPage() {
  const queryClient = useQueryClient();
  const saveSection = useSaveSection(queryClient);

  const health = useQuery({ queryKey: ['health'], queryFn: () => getJson<Health>('/health') });
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => getJson<Cfg>('/settings'),
    staleTime: 30_000,
  });
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => getJson<ProjectListResponse>('/projects'),
    staleTime: 30_000,
  });

  const cfg = settings.data ?? ({} as Cfg);
  const providers = Array.isArray(cfg.providers) ? cfg.providers as Array<Record<string, unknown>> : [];
  const projectList = projects.data?.projects ?? [];
  const defaultProjectId = projects.data?.defaultProjectId;

  // ── Draft state (syncs from server data) ──────────────────
  const serverCfg = (cfg.server ?? {}) as Record<string, unknown>;
  const agentCfg = (cfg.agent ?? {}) as Record<string, unknown>;
  const agentIdentity = (agentCfg.identity ?? {}) as Record<string, unknown>;
  const judgeCfg = (cfg.judge ?? {}) as Record<string, unknown>;
  const reviewCfg = (cfg.review ?? {}) as Record<string, unknown>;
  const reviewRoles = (reviewCfg.roles ?? {}) as Record<string, Record<string, unknown>>;
  const memoryCfg = (cfg.memory ?? {}) as Record<string, unknown>;
  const executorCfg = (cfg.executor ?? {}) as Record<string, unknown>;
  const authCfg = (cfg.auth ?? {}) as Record<string, unknown>;

  // Server draft
  const [serverDraft, setServerDraft] = useState({ port: Number(serverCfg.port ?? 8080), host: String(serverCfg.host ?? '127.0.0.1'), corsOrigin: String(serverCfg.corsOrigin ?? 'http://localhost:5173') });
  // Agent draft
  const [agentDraft, setAgentDraft] = useState({ defaultProvider: String(agentCfg.defaultProvider ?? ''), defaultModel: String(agentCfg.defaultModel ?? ''), maxLoops: Number(agentCfg.maxLoops ?? 20), sandboxMode: String(agentCfg.sandboxMode ?? 'workspace-write'), systemPrompt: String(agentCfg.systemPrompt ?? '') });
  // Identity draft
  const [identityDraft, setIdentityDraft] = useState({ name: String(agentIdentity.name ?? 'default'), level: String(agentIdentity.level ?? ''), inheritForChildren: Boolean(agentIdentity.inheritForChildren) });
  // Judge draft
  const [judgeDraft, setJudgeDraft] = useState({ provider: String(judgeCfg.provider ?? ''), model: String(judgeCfg.model ?? ''), systemPrompt: String(judgeCfg.systemPrompt ?? '') });
  // Review draft
  const [reviewEnabled, setReviewEnabled] = useState(Boolean(reviewCfg.enabled));
  // Memory draft
  const [memoryDraft, setMemoryDraft] = useState({ ftsEnabled: Boolean(memoryCfg.ftsEnabled ?? true), maxObservations: Number(memoryCfg.maxObservations ?? 10000), selfReflectionEnabled: Boolean(memoryCfg.selfReflectionEnabled) });
  // Executor draft
  const [executorDraft, setExecutorDraft] = useState({ enabled: Boolean(executorCfg.enabled), nodeId: String(executorCfg.nodeId ?? ''), connectModes: String(Array.isArray(executorCfg.connectModes) ? (executorCfg.connectModes as string[]).join(', ') : ''), meshNodes: String(Array.isArray(executorCfg.meshNodes) ? (executorCfg.meshNodes as string[]).join('\n') : ''), meshNodeCount: Number(executorCfg.meshNodeCount ?? 0) });
  // Auth draft
  const [authEnabled, setAuthEnabled] = useState(Boolean(authCfg.enabled));

  // Sync drafts when server data changes
  useEffect(() => { setServerDraft({ port: Number(serverCfg.port ?? 8080), host: String(serverCfg.host ?? '127.0.0.1'), corsOrigin: String(serverCfg.corsOrigin ?? 'http://localhost:5173') }); }, [serverCfg.port, serverCfg.host, serverCfg.corsOrigin]);
  useEffect(() => { setAgentDraft({ defaultProvider: String(agentCfg.defaultProvider ?? ''), defaultModel: String(agentCfg.defaultModel ?? ''), maxLoops: Number(agentCfg.maxLoops ?? 20), sandboxMode: String(agentCfg.sandboxMode ?? 'workspace-write'), systemPrompt: String(agentCfg.systemPrompt ?? '') }); }, [agentCfg.defaultProvider, agentCfg.defaultModel, agentCfg.maxLoops, agentCfg.sandboxMode, agentCfg.systemPrompt]);
  useEffect(() => { setIdentityDraft({ name: String(agentIdentity.name ?? 'default'), level: String(agentIdentity.level ?? ''), inheritForChildren: Boolean(agentIdentity.inheritForChildren) }); }, [agentIdentity.name, agentIdentity.level, agentIdentity.inheritForChildren]);
  useEffect(() => { setJudgeDraft({ provider: String(judgeCfg.provider ?? ''), model: String(judgeCfg.model ?? ''), systemPrompt: String(judgeCfg.systemPrompt ?? '') }); }, [judgeCfg.provider, judgeCfg.model, judgeCfg.systemPrompt]);
  useEffect(() => { setReviewEnabled(Boolean(reviewCfg.enabled)); }, [reviewCfg.enabled]);
  useEffect(() => { setMemoryDraft({ ftsEnabled: Boolean(memoryCfg.ftsEnabled ?? true), maxObservations: Number(memoryCfg.maxObservations ?? 10000), selfReflectionEnabled: Boolean(memoryCfg.selfReflectionEnabled) }); }, [memoryCfg.ftsEnabled, memoryCfg.maxObservations, memoryCfg.selfReflectionEnabled]);
  useEffect(() => { setExecutorDraft({ enabled: Boolean(executorCfg.enabled), nodeId: String(executorCfg.nodeId ?? ''), connectModes: String(Array.isArray(executorCfg.connectModes) ? (executorCfg.connectModes as string[]).join(', ') : ''), meshNodes: String(Array.isArray(executorCfg.meshNodes) ? (executorCfg.meshNodes as string[]).join('\n') : ''), meshNodeCount: Number(executorCfg.meshNodeCount ?? 0) }); }, [executorCfg.enabled, executorCfg.nodeId, executorCfg.connectModes, executorCfg.meshNodes, executorCfg.meshNodeCount]);
  useEffect(() => { setAuthEnabled(Boolean(authCfg.enabled)); }, [authCfg.enabled]);

  return (
    <section className="panel-grid settings-grid">
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Settings</h2>
            <p>Edit runtime configuration. Changes are applied immediately.</p>
          </div>
          <StatusPill status="live" />
        </div>

        {/* ── Auth ──────────────────────────────────────── */}
        <SectionHeader title="Auth" onSave={() => saveSection.mutate({ auth: { enabled: authEnabled } })} saving={saveSection.isPending} />
        <ToggleField label="enabled" checked={authEnabled} onChange={setAuthEnabled} />

        {/* ── Server ────────────────────────────────────── */}
        <SectionHeader title="Server" onSave={() => saveSection.mutate({ server: serverDraft })} saving={saveSection.isPending} />
        <NumberField label="port" value={serverDraft.port} onChange={v => setServerDraft(p => ({ ...p, port: v }))} />
        <TextField label="host" value={serverDraft.host} onChange={v => setServerDraft(p => ({ ...p, host: v }))} />
        <TextField label="CORS origin" value={serverDraft.corsOrigin} onChange={v => setServerDraft(p => ({ ...p, corsOrigin: v }))} />

        {/* ── Agent ─────────────────────────────────────── */}
        <SectionHeader title="Agent" onSave={() => saveSection.mutate({ agent: agentDraft })} saving={saveSection.isPending} />
        <TextField label="default provider" value={agentDraft.defaultProvider} onChange={v => setAgentDraft(p => ({ ...p, defaultProvider: v }))} />
        <TextField label="default model" value={agentDraft.defaultModel} onChange={v => setAgentDraft(p => ({ ...p, defaultModel: v }))} />
        <NumberField label="max loops" value={agentDraft.maxLoops} onChange={v => setAgentDraft(p => ({ ...p, maxLoops: v }))} />
        <SelectField label="sandbox mode" value={agentDraft.sandboxMode} options={['readonly', 'workspace-write', 'sandbox']} onChange={v => setAgentDraft(p => ({ ...p, sandboxMode: v }))} />
        <Field label="system prompt">
          <textarea rows={3} value={agentDraft.systemPrompt} onChange={e => setAgentDraft(p => ({ ...p, systemPrompt: e.target.value }))} />
        </Field>

        {/* ── Agent Identity ────────────────────────────── */}
        <SectionHeader title="Agent Identity" onSave={() => saveSection.mutate({ agent: { ...agentDraft, identity: identityDraft } })} saving={saveSection.isPending} />
        <TextField label="name" value={identityDraft.name} onChange={v => setIdentityDraft(p => ({ ...p, name: v }))} />
        <SelectField label="level" value={identityDraft.level} options={['', 'none', 'minimal', 'standard', 'full']} onChange={v => setIdentityDraft(p => ({ ...p, level: v }))} />
        <ToggleField label="inherit for children" checked={identityDraft.inheritForChildren} onChange={v => setIdentityDraft(p => ({ ...p, inheritForChildren: v }))} />

        {/* ── Judge ─────────────────────────────────────── */}
        <SectionHeader title="Judge (P0-2)" onSave={() => saveSection.mutate({ judge: judgeDraft })} saving={saveSection.isPending} />
        <TextField label="provider" value={judgeDraft.provider} onChange={v => setJudgeDraft(p => ({ ...p, provider: v }))} />
        <TextField label="model" value={judgeDraft.model} onChange={v => setJudgeDraft(p => ({ ...p, model: v }))} />
        <Field label="system prompt">
          <textarea rows={3} value={judgeDraft.systemPrompt} onChange={e => setJudgeDraft(p => ({ ...p, systemPrompt: e.target.value }))} />
        </Field>

        {/* ── Review ────────────────────────────────────── */}
        <SectionHeader title="Multi-Role Review (P0)" onSave={() => saveSection.mutate({ review: { enabled: reviewEnabled, roles: reviewRoles } })} saving={saveSection.isPending} />
        <ToggleField label="enabled" checked={reviewEnabled} onChange={setReviewEnabled} />
        {Object.keys(reviewRoles).length === 0 ? (
          <EmptyText text="No review roles configured. Add roles in ~/.los/config.yaml under review.roles." />
        ) : (
          Object.entries(reviewRoles).map(([name, role]) => (
            <div key={name} style={{ marginTop: 8 }}>
              <SectionHeader title={`Role: ${name}`} />
              <TextField label="provider" value={String(role.provider ?? '')} onChange={v => { /* roles are read-only in this UI for now */ }} />
              <TextField label="model" value={String(role.model ?? '')} onChange={v => { }} />
              <SelectField label="blocking severity" value={String(role.blockingSeverity ?? 'critical')} options={['critical', 'error', 'warn', 'info']} onChange={v => { }} />
              <ToggleField label="enabled" checked={Boolean(role.enabled ?? true)} onChange={v => { }} />
            </div>
          ))
        )}

        {/* ── Memory ────────────────────────────────────── */}
        <SectionHeader title="Memory" onSave={() => saveSection.mutate({ memory: memoryDraft })} saving={saveSection.isPending} />
        <ToggleField label="FTS enabled" checked={memoryDraft.ftsEnabled} onChange={v => setMemoryDraft(p => ({ ...p, ftsEnabled: v }))} />
        <NumberField label="max observations" value={memoryDraft.maxObservations} onChange={v => setMemoryDraft(p => ({ ...p, maxObservations: v }))} />
        <ToggleField label="self-reflection" checked={memoryDraft.selfReflectionEnabled} onChange={v => setMemoryDraft(p => ({ ...p, selfReflectionEnabled: v }))} />

        {/* ── Executor ──────────────────────────────────── */}
        <SectionHeader title="Executor" onSave={() => saveSection.mutate({ executor: { enabled: executorDraft.enabled, nodeId: executorDraft.nodeId, connectModes: executorDraft.connectModes ? executorDraft.connectModes.split(',').map(s => s.trim()).filter(Boolean) : [], meshNodes: executorDraft.meshNodes ? executorDraft.meshNodes.split('\n').map(s => s.trim()).filter(Boolean) : [] } })} saving={saveSection.isPending} />
        <ToggleField label="enabled" checked={executorDraft.enabled} onChange={v => setExecutorDraft(p => ({ ...p, enabled: v }))} />
        <TextField label="node ID" value={executorDraft.nodeId} onChange={v => setExecutorDraft(p => ({ ...p, nodeId: v }))} />
        <TextField label="connect modes" value={executorDraft.connectModes} onChange={v => setExecutorDraft(p => ({ ...p, connectModes: v }))} />
        <Field label="mesh nodes (one per line)">
          <textarea rows={4} value={executorDraft.meshNodes} onChange={e => setExecutorDraft(p => ({ ...p, meshNodes: e.target.value }))} />
        </Field>

        {/* ── Providers (read-only summary) ─────────────── */}
        {providers.length > 0 ? (
          <>
            <SectionHeader title="Providers" />
            {providers.map((p, i) => (
              <div key={i} className="definition">
                <strong>{String(p.name ?? `provider-${i}`)}</strong>
                <span>{`${p.enabled ? 'enabled' : 'disabled'} · ${p.hasApiKey ? 'key set' : 'no key'}${p.model ? ` · ${p.model}` : ''}${p.weight ? ` · weight:${p.weight}` : ''}`}</span>
              </div>
            ))}
          </>
        ) : null}
      </div>

      {/* ── Runtime (sidebar) ───────────────────────────── */}
      <aside className="panel inspector">
        <div className="panel-head compact"><h2>Runtime</h2></div>
        <div className="fact-list">
          <Fact label="gateway" value={health.data?.status ?? 'unknown'} />
          <Fact label="uptime" value={formatDuration(health.data?.uptime ?? 0)} />
        </div>
      </aside>

      {/* ── Project Management ──────────────────────────── */}
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Projects</h2>
            <p>Bound workspace directories. Click to set as default.</p>
          </div>
          <StatusPill status={projectList.length > 0 ? 'live' : 'partial'} />
        </div>
        {projectList.length === 0 ? (
          <div style={{ padding: '12px 0', color: 'var(--text-dim)', fontSize: '13px' }}>No projects bound. Use the &quot;bind project&quot; action on the Chat page to register a workspace.</div>
        ) : (
          <table className="project-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Path</th>
                <th>Last Used</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {projectList
                .sort((a, b) => b.lastUsed.localeCompare(a.lastUsed))
                .map(p => (
                  <tr key={p.projectId} className={p.projectId === defaultProjectId ? 'project-default-row' : ''}>
                    <td>
                      <span className="project-name">{p.displayName}</span>
                      {p.projectId === defaultProjectId ? <span className="default-badge">default</span> : null}
                    </td>
                    <td className="project-path-cell" title={p.workspacePath}>{p.workspacePath}</td>
                    <td className="text-dim">{p.lastUsed ? new Date(p.lastUsed).toLocaleDateString() : '—'}</td>
                    <td>
                      <button type="button" className="ghost-btn"
                        title="Remove project binding"
                        onClick={async () => {
                          await deleteJson(`/projects/${p.projectId}`);
                          queryClient.invalidateQueries({ queryKey: ['projects'] });
                        }}>
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
