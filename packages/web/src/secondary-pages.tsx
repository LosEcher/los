import { type ReactNode, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Braces, Search } from 'lucide-react';
import {
  getJson,
  type Health,
  type LogFile,
  type LogsResponse,
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
  const health = useQuery({ queryKey: ['health'], queryFn: () => getJson<Health>('/health') });
  return (
    <section className="panel-grid settings-grid">
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Settings</h2>
            <p>Partial surface. Runtime writes should be added only after config ownership is explicit.</p>
          </div>
          <StatusPill status="partial" />
        </div>
        <div className="definition-list">
          <Definition term="read/write now" text="Chat prompt execution, Memory observations." />
          <Definition term="read-only now" text="Sessions, Tasks, Logs, Provider discovery, Nodes, Skills, Rules." />
          <Definition term="deferred writes" text="Provider credentials, rule edits, node maintenance, skill source edits." />
        </div>
      </div>
      <aside className="panel inspector">
        <div className="panel-head compact"><h2>Runtime</h2></div>
        <div className="fact-list">
          <Fact label="gateway" value={health.data?.status ?? 'unknown'} />
          <Fact label="uptime" value={formatDuration(health.data?.uptime ?? 0)} />
          <Fact label="api boundary" value="packages/gateway" />
          <Fact label="web package" value="packages/web" />
        </div>
      </aside>
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
