import { type ReactNode, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Braces, Search, Trash2, FileText } from 'lucide-react';
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
import { useI18n } from '../i18n';

export function LogsPage() {
  const { t } = useI18n();
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

  const hasFiles = (files.data?.length ?? 0) > 0;
  const hasEntries = (logs.data?.entries?.length ?? 0) > 0;

  return (
    <section className="panel ops-page">
      <div className="panel-head">
        <div>
          <h2>{t('nav.logs')}</h2>
          <p>{t('ops.logs.subtitle')}</p>
        </div>
        <div className="toolbar">
          <select className="filter-select" value={selectedFile} onChange={event => setFile(event.target.value)} disabled={!hasFiles}>
            {hasFiles
              ? (files.data ?? []).map(item => <option key={item.name} value={item.name}>{item.name}</option>)
              : <option value="">{t('ops.logs.noLogFiles')}</option>}
          </select>
          <select className="filter-select" value={level} onChange={event => setLevel(event.target.value)}>
            <option value="">{t('ops.logs.allLevels')}</option>
            <option value="debug">debug</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
          <div className="search-box">
            <Search size={14} />
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('ops.logs.filterPlaceholder')} />
          </div>
        </div>
      </div>
      <div className="log-table">
        {files.isLoading ? <EmptyText text={t('ops.logs.loadingFiles')} /> : null}
        {logs.isLoading ? <EmptyText text={t('ops.logs.loadingEntries')} /> : null}
        {!files.isLoading && !hasFiles ? (
          <div className="daily-empty">
            <FileText size={28} />
            <p>{t('ops.logs.emptyFilesTitle')}</p>
            <span>{t('ops.logs.emptyFilesHintBefore')} <code>.los-runtime/gateway.log</code> {t('ops.logs.emptyFilesHintAfter')}</span>
          </div>
        ) : !logs.isLoading && !hasEntries ? (
          <EmptyText text={query || level ? t('ops.logs.noMatches') : t('ops.logs.noEntries')} />
        ) : (
          (logs.data?.entries ?? []).map((entry, index) => (
            <div className="log-row" data-level={entry.level} key={`${entry.timestamp}-${index}`}>
              <span>{formatTime(entry.timestamp)}</span>
              <strong>{entry.level}</strong>
              <em>{entry.package ?? 'runtime'}</em>
              <p>{entry.message}</p>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
