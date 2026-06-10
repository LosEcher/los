import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import {
  getJson,
  deleteJson,
  type Health,
  type ProjectListResponse,
} from '../api/index.js';
import {
  Definition,
  Fact,
  formatDuration,
  StatusPill,
} from '../ui.js';

export function SettingsPage() {
  const queryClient = useQueryClient();
  const health = useQuery({ queryKey: ['health'], queryFn: () => getJson<Health>('/health') });
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => getJson<Record<string, unknown>>('/settings'),
    staleTime: 30_000,
  });
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => getJson<ProjectListResponse>('/projects'),
    staleTime: 30_000,
  });
  const cfg = (settings.data ?? {}) as Record<string, Record<string, unknown>>;
  const providers = Array.isArray(cfg.providers) ? cfg.providers as Array<Record<string, unknown>> : [];
  const projectList = projects.data?.projects ?? [];
  const defaultProjectId = projects.data?.defaultProjectId;

  return (
    <section className="panel-grid settings-grid">
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Settings</h2>
            <p>Runtime configuration. Writes require explicit config ownership.</p>
          </div>
          <StatusPill status="partial" />
        </div>
        <div className="definition-list">
          <div className="section-divider"><strong>Server</strong></div>
          <Definition term="port" text={String((cfg.server as Record<string, unknown> | undefined)?.port ?? '—')} />
          <Definition term="host" text={String((cfg.server as Record<string, unknown> | undefined)?.host ?? '—')} />

          <div className="section-divider"><strong>Agent</strong></div>
          <Definition term="default provider" text={String((cfg.agent as Record<string, unknown> | undefined)?.defaultProvider ?? '—')} />
          <Definition term="default model" text={String((cfg.agent as Record<string, unknown> | undefined)?.defaultModel ?? '—')} />
          <Definition term="max loops" text={String((cfg.agent as Record<string, unknown> | undefined)?.maxLoops ?? '—')} />
          <Definition term="sandbox mode" text={String((cfg.agent as Record<string, unknown> | undefined)?.sandboxMode ?? '—')} />

          <div className="section-divider"><strong>Memory</strong></div>
          <Definition term="FTS enabled" text={String((cfg.memory as Record<string, unknown> | undefined)?.ftsEnabled ?? '—')} />
          <Definition term="max observations" text={String((cfg.memory as Record<string, unknown> | undefined)?.maxObservations ?? '—')} />

          <div className="section-divider"><strong>Executor</strong></div>
          <Definition term="enabled" text={String((cfg.executor as Record<string, unknown> | undefined)?.enabled ?? '—')} />
          <Definition term="node ID" text={String((cfg.executor as Record<string, unknown> | undefined)?.nodeId ?? '—')} />
          <Definition term="mesh nodes" text={String((cfg.executor as Record<string, unknown> | undefined)?.meshNodeCount ?? '—')} />

          {providers.length > 0 ? (
            <>
              <div className="section-divider"><strong>Providers</strong></div>
              {providers.map((p, i) => (
                <Definition key={i}
                  term={String(p.name ?? `provider-${i}`)}
                  text={`${p.enabled ? 'enabled' : 'disabled'} · ${p.hasApiKey ? 'key set' : 'no key'}${p.model ? ` · ${p.model}` : ''}${p.weight ? ` · weight:${p.weight}` : ''}`}
                />
              ))}
            </>
          ) : null}
        </div>
      </div>
      <aside className="panel inspector">
        <div className="panel-head compact"><h2>Runtime</h2></div>
        <div className="fact-list">
          <Fact label="gateway" value={health.data?.status ?? 'unknown'} />
          <Fact label="uptime" value={formatDuration(health.data?.uptime ?? 0)} />
        </div>
      </aside>

      {/* ── Project Management ───────────────────────── */}
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
