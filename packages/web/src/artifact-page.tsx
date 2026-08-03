import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, FileText, Trash2 } from 'lucide-react';
import { deleteJson, getJson, type ArtifactListResponse, type ArtifactRecord } from './api';
import { DataTable, EmptyText, Fact, formatDate, StatusPill } from './ui';
import { useI18n } from './i18n';

type T = ReturnType<typeof useI18n>['t'];

export function ArtifactsPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { t } = useI18n();

  const artifacts = useQuery({
    queryKey: ['artifacts'],
    queryFn: () => getJson<ArtifactListResponse>('/artifacts?limit=100'),
    refetchInterval: 15_000,
  });

  const list = artifacts.data?.artifacts ?? [];
  const selected = list.find(a => a.artifactId === selectedId) ?? null;

  const remove = useMutation({
    mutationFn: (artifactId: string) => deleteJson(`/artifacts/${encodeURIComponent(artifactId)}`),
    onSuccess: () => {
      setSelectedId(null);
      queryClient.invalidateQueries({ queryKey: ['artifacts'] });
    },
  });

  return (
    <section className="panel-grid detail-grid">
      <div className="panel">
        <div className="panel-head">
          <div className="title-row">
            <Archive size={18} />
            <div>
              <h2>{t('assets.artifact.title')}</h2>
              <p>{t('assets.artifact.subtitle')}</p>
            </div>
          </div>
          <StatusPill status="live" />
        </div>
        <DataTable
          loading={artifacts.isLoading}
          empty={t('assets.artifact.emptyList')}
          rows={list}
          renderRow={artifact => (
            <button
              type="button"
              className="record-row"
              data-active={selected?.artifactId === artifact.artifactId}
              onClick={() => setSelectedId(artifact.artifactId)}
            >
              <span className="row-title">{artifact.artifactId}</span>
              <span>{artifact.path}</span>
              <span>{formatBytes(artifact.size, t)}</span>
              <span>{artifact.mimeType ?? t('common.unknown')}</span>
              <span>{artifact.sessionId ? t('assets.artifact.sessionRef', { id: artifact.sessionId.slice(0, 8) }) : t('assets.artifact.noSession')}</span>
              <span>{formatDate(artifact.createdAt)}</span>
            </button>
          )}
        />
      </div>

      <aside className="panel inspector">
        {selected ? (
          <>
            <div className="panel-head compact">
              <h2>{t('assets.artifact.detailTitle')}</h2>
              <span className="mono-chip">{selected.artifactId}</span>
            </div>
            <div className="fact-list compact-facts">
              <Fact label={t('assets.label.path')} value={selected.path} />
              <Fact label={t('assets.label.size')} value={formatBytes(selected.size, t)} />
              <Fact label={t('assets.label.mimeType')} value={selected.mimeType ?? t('common.unknown')} />
              <Fact label={t('assets.label.session')} value={selected.sessionId ?? t('common.none')} />
              <Fact label={t('assets.label.taskRun')} value={selected.taskRunId ?? t('common.none')} />
              <Fact label={t('assets.label.node')} value={selected.nodeId ?? t('assets.artifact.local')} />
              <Fact label={t('assets.label.hash')} value={selected.contentHash ?? t('common.none')} />
              <Fact label={t('assets.label.created')} value={formatDate(selected.createdAt)} />
            </div>
            <div className="inline-actions">
              <button
                className="ghost-btn"
                type="button"
                disabled={remove.isPending}
                onClick={() => remove.mutate(selected.artifactId)}
              >
                <Trash2 size={14} /> {t('common.delete')}
              </button>
            </div>
          </>
        ) : (
          <EmptyText text={t('assets.artifact.selectHint')} />
        )}
      </aside>
    </section>
  );
}

function formatBytes(bytes: number, t: T): string {
  if (!Number.isFinite(bytes)) return t('assets.artifact.bytesZero');
  if (bytes < 1024) return t('assets.artifact.bytes', { bytes });
  if (bytes < 1024 * 1024) return t('assets.artifact.kilobytes', { bytes: (bytes / 1024).toFixed(1) });
  return t('assets.artifact.megabytes', { bytes: (bytes / (1024 * 1024)).toFixed(1) });
}
