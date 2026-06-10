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
} from '../api/index.js';
import {
  Definition,
  EmptyText,
  Fact,
  formatDuration,
  formatTime,
  StatusPill,
} from '../ui.js';

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
