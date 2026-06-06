import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, FileText, Trash2 } from 'lucide-react';
import { deleteJson, getJson, type ArtifactListResponse, type ArtifactRecord } from './api';
import { DataTable, EmptyText, Fact, formatDate, StatusPill } from './ui';

export function ArtifactsPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
              <h2>Artifacts</h2>
              <p>Stored file artifacts from agent runs. Browse paths, sizes, and linked sessions.</p>
            </div>
          </div>
          <StatusPill status="live" />
        </div>
        <DataTable
          loading={artifacts.isLoading}
          empty="No artifacts stored."
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
              <span>{formatBytes(artifact.size)}</span>
              <span>{artifact.mimeType ?? 'unknown'}</span>
              <span>{artifact.sessionId ? `session:${artifact.sessionId.slice(0, 8)}` : 'no session'}</span>
              <span>{formatDate(artifact.createdAt)}</span>
            </button>
          )}
        />
      </div>

      <aside className="panel inspector">
        {selected ? (
          <>
            <div className="panel-head compact">
              <h2>Artifact Detail</h2>
              <span className="mono-chip">{selected.artifactId}</span>
            </div>
            <div className="fact-list compact-facts">
              <Fact label="path" value={selected.path} />
              <Fact label="size" value={formatBytes(selected.size)} />
              <Fact label="mime type" value={selected.mimeType ?? 'unknown'} />
              <Fact label="session" value={selected.sessionId ?? 'none'} />
              <Fact label="task run" value={selected.taskRunId ?? 'none'} />
              <Fact label="node" value={selected.nodeId ?? 'local'} />
              <Fact label="hash" value={selected.contentHash ?? 'none'} />
              <Fact label="created" value={formatDate(selected.createdAt)} />
            </div>
            <div className="inline-actions">
              <button
                className="ghost-btn"
                type="button"
                disabled={remove.isPending}
                onClick={() => remove.mutate(selected.artifactId)}
              >
                <Trash2 size={14} /> delete
              </button>
            </div>
          </>
        ) : (
          <EmptyText text="Select an artifact to inspect metadata." />
        )}
      </aside>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
