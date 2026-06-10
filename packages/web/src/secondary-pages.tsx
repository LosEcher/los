import { type ReactNode, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Braces, Search, Trash2 } from 'lucide-react';
import {
  getJson,
  deleteJson,
  type Health,
  type LogFile,
  type LogsResponse,
  type ProjectListResponse,
} from './api';
import {
  Definition,
  EmptyText,
  Fact,
  formatDuration,
  formatTime,
  StatusPill,
} from './ui';

export function LogsPage() {
  const [file, setFile] = useState('');
  const [level, setLevel] = useState('');
  const [query, setQuery] = useState('');
  const files = useQuery({
    queryKey: ['logs-files'],
    queryFn: () => getJson<LogFile[]>('/logs/files'),
  });
  const selectedFile = file || files.data?.[0]?.name || '';
  const logs = useQuery({
    queryKey: ['logs', selectedFile, level, query],
    queryFn: () => getJson<LogsResponse>(`/logs?lines=240&file=${encodeURIComponent(selectedFile)}&level=${encodeURIComponent(level)}&q=${encodeURIComponent(query)}`),
    enabled: Boolean(selectedFile) || files.isSuccess,
    refetchInterval: 5_000,
  });

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Logs</h2>
          <p>Read-only tail over `.los-runtime` log files.</p>
        </div>
        <div className="toolbar">
          <select value={selectedFile} onChange={event => setFile(event.target.value)}>
            {(files.data ?? []).map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
          </select>
          <select value={level} onChange={event => setLevel(event.target.value)}>
            <option value="">all levels</option>
            <option value="debug">debug</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
          <div className="search-box">
            <Search size={14} />
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="filter logs" />
          </div>
        </div>
      </div>
      <div className="log-table">
        {logs.isLoading ? <EmptyText text="Loading logs..." /> : null}
        {(logs.data?.entries ?? []).map((entry, index) => (
          <div className="log-row" data-level={entry.level} key={`${entry.timestamp}-${index}`}>
            <span>{formatTime(entry.timestamp)}</span>
            <strong>{entry.level}</strong>
            <em>{entry.package ?? 'runtime'}</em>
            <p>{entry.message}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

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

export function ReservedPage({ kind, icon, description, fields }: { kind: string; icon: ReactNode; description: string; fields: string[] }) {
  return (
    <section className="panel-grid settings-grid">
      <div className="panel">
        <div className="panel-head">
          <div className="title-row">
            {icon}
            <div>
              <h2>{kind}</h2>
              <p>{description}</p>
            </div>
          </div>
          <StatusPill status="reserved" />
        </div>
        <div className="field-grid">
          {fields.map(field => (
            <div className="field-token" key={field}>
              <Braces size={14} />
              <span>{field}</span>
            </div>
          ))}
        </div>
      </div>
      <aside className="panel inspector">
        <div className="panel-head compact"><h2>Initial Policy</h2></div>
        <div className="definition-list">
          <Definition term="phase 1" text="Read-only view." />
          <Definition term="write gate" text="Requires storage contract, validation, and event evidence." />
          <Definition term="audit" text="Every future mutation must link to task/session evidence." />
        </div>
      </aside>
    </section>
  );
}
