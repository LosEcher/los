import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCcw, Search } from 'lucide-react';
import { getJson, postJson } from '../api/index.js';
import { DataTable, Fact, StatusPill, EmptyText } from '../ui.js';

interface FileSyncNode {
  nodeId: string;
  folders?: FileSyncFolder[];
  error?: string;
}

interface FileSyncFolder {
  folderId: string;
  name: string;
  localPath: string;
  status: string;
  scanIntervalSec: number;
  lastScanAt: string | null;
  lastScanDurationMs: number | null;
  totalFiles?: number;
  inSyncFiles?: number;
}

interface FileSyncEvent {
  eventId: string;
  folderId?: string;
  filePath?: string;
  event: string;
  nodeId: string;
  detail?: Record<string, unknown>;
  createdAt: string;
}

export function FileSyncPage() {
  const queryClient = useQueryClient();
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [scanFolder, setScanFolder] = useState('');

  const status = useQuery({
    queryKey: ['file-sync-status'],
    queryFn: () => getJson<{ ok: boolean; nodes: FileSyncNode[] }>('/file-sync/status'),
    refetchInterval: 15_000,
  });

  const events = useQuery({
    queryKey: ['file-sync-events'],
    queryFn: () => getJson<{ ok: boolean; events: FileSyncEvent[] }>('/file-sync/events?limit=50'),
    refetchInterval: 15_000,
  });

  const triggerScan = useMutation({
    mutationFn: (params: { nodeId: string; folder?: string }) =>
      postJson('/file-sync/scan', params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['file-sync-status'] });
      queryClient.invalidateQueries({ queryKey: ['file-sync-events'] });
    },
  });

  const nodes = status.data?.nodes ?? [];
  const eventList = events.data?.events ?? [];

  // Flatten folders across all nodes
  const allFolders = nodes.flatMap(n =>
    (n.folders ?? []).map(f => ({ ...f, nodeId: n.nodeId }))
  );

  return (
    <section className="panel-grid">
      {/* ── Folder Status ──────────────────────────────── */}
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>File Sync</h2>
            <p>Cross-node file synchronization status and scan control.</p>
          </div>
          <StatusPill status={nodes.length > 0 ? 'live' : 'partial'} />
        </div>

        <div className="fact-list" style={{ marginBottom: 16 }}>
          <Fact label="sync nodes" value={String(nodes.length)} />
          <Fact label="tracked folders" value={String(allFolders.length)} />
          <Fact label="recent events" value={String(eventList.length)} />
        </div>

        {/* Scan trigger */}
        {nodes.length > 0 ? (
          <div style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <select
              value={selectedNode ?? ''}
              onChange={e => setSelectedNode(e.target.value || null)}
              style={{ flex: 1 }}
            >
              <option value="">Select node...</option>
              {nodes.map(n => (
                <option key={n.nodeId} value={n.nodeId}>{n.nodeId}</option>
              ))}
            </select>
            <input
              type="text"
              value={scanFolder}
              onChange={e => setScanFolder(e.target.value)}
              placeholder="folder name (default: all)"
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="ghost-btn"
              disabled={!selectedNode || triggerScan.isPending}
              onClick={() => triggerScan.mutate({
                nodeId: selectedNode!,
                folder: scanFolder || undefined,
              })}
            >
              <Search size={14} /> {triggerScan.isPending ? 'scanning...' : 'scan'}
            </button>
          </div>
        ) : null}

        <DataTable
          loading={status.isLoading}
          empty="No file-sync nodes found. Register executor nodes with file_sync_scan capability."
          rows={allFolders}
          renderRow={(f) => (
            <div key={f.folderId ?? f.name} className="record-row">
              <div className="record-main">
                <div className="record-header">
                  <strong className="record-title">{f.name}</strong>
                  <span className={`status-pill ${f.status === 'active' ? 'live' : 'partial'}`}>
                    {f.status ?? 'unknown'}
                  </span>
                </div>
                <div className="record-meta">
                  <span>node: {f.nodeId}</span>
                  <span> · {f.localPath}</span>
                  {f.totalFiles !== undefined ? <span> · {f.totalFiles} files</span> : null}
                  {f.inSyncFiles !== undefined ? <span> · {f.inSyncFiles} in sync</span> : null}
                  {f.lastScanAt ? <span> · last scan: {new Date(f.lastScanAt).toLocaleString()}</span> : null}
                  {f.lastScanDurationMs ? <span> · {(f.lastScanDurationMs / 1000).toFixed(1)}s</span> : null}
                </div>
              </div>
            </div>
          )}
        />
      </div>

      {/* ── Recent Events ──────────────────────────────── */}
      <aside className="panel inspector">
        <div className="panel-head compact">
          <h2>Events</h2>
          <button type="button" className="ghost-btn" onClick={() => {
            queryClient.invalidateQueries({ queryKey: ['file-sync-events'] });
          }}>
            <RefreshCcw size={14} />
          </button>
        </div>
        {eventList.length === 0 ? (
          <EmptyText text={events.isLoading ? 'Loading...' : 'No recent events.'} />
        ) : (
          <div className="record-list" style={{ maxHeight: 500, overflowY: 'auto' }}>
            {eventList.map(e => (
              <div key={e.eventId} className="record-row">
                <div className="record-main">
                  <div className="record-header">
                    <span className={`status-pill ${e.event === 'scan_completed' ? 'live' : e.event === 'error' ? 'reserved' : 'partial'}`}>
                      {e.event}
                    </span>
                  </div>
                  <div className="record-meta">
                    <span>{e.nodeId}</span>
                    {e.filePath ? <span> · {e.filePath}</span> : null}
                    <span> · {new Date(e.createdAt).toLocaleString()}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </aside>
    </section>
  );
}
