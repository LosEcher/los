import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Network, Plus, Upload } from 'lucide-react';
import { getJson, postJson, type SshConfigImportResponse } from './api';
import { DataTable, EmptyText, Fact, Field, formatDate, RefreshQueryButton, StatusPill } from './ui';
import { NodeEditor, NodeInspector, errorMessage, fmtMb } from './node-editor.js';

function shortCapFlags(capabilities: Record<string, unknown>): string {
  const parts: string[] = [];
  if (capabilities.deploy_safe === true) parts.push('d');
  if (capabilities.heavy_task_safe === true) parts.push('H');
  return parts.join('/') || '?';
}

function resourceCell(capacity: Record<string, unknown>): string {
  const mem = fmtMb(capacity.memoryTotalMb);
  const swap = fmtMb(capacity.swapTotalMb);
  if (mem === '?' && swap === '?') return '?';
  return `${mem}/${swap}`;
}

export function NodesPage() {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string>('Registry edits are local until saved.');
  const nodes = useQuery({
    queryKey: ['nodes'],
    queryFn: () => getJson<Array<{ nodeId: string; nodeKind: string; status: string; connectModes: string[]; rolloutState?: string; targetVersion?: string; execution: { candidate: boolean; blockers?: string[]; warnings?: string[] }; lastHeartbeatAt: string; capacity?: Record<string, unknown>; capabilities?: Record<string, unknown> }>>('/nodes'),
    refetchInterval: 8_000,
  });
  const selectedNode = useMemo(() => {
    const all = nodes.data ?? [];
    return all.find(node => node.nodeId === selectedNodeId) ?? all[0] ?? null;
  }, [nodes.data, selectedNodeId]);

  return (
    <section className="panel-grid settings-grid">
      <div className="panel">
        <div className="panel-head">
          <div className="title-row">
            <Network size={18} />
            <div>
              <h2>Executor Nodes</h2>
              <p>Manual registry editing, dry-run probe, and live verified state.</p>
            </div>
          </div>
          <div className="toolbar">
            <StatusPill status="live" />
            <RefreshQueryButton queryKey={['nodes']} />
          </div>
        </div>
        <NodeEditor
          node={selectedNode as any}
          onChangeSelected={setSelectedNodeId}
          onSaved={async message => {
            setActionMessage(message);
            await nodes.refetch();
          }}
          onProbed={async message => {
            setActionMessage(message);
            await nodes.refetch();
          }}
        />
        <SshImportPanel
          onImported={async message => {
            setActionMessage(message);
            await nodes.refetch();
          }}
        />
        <div className="panel-head compact">
          <div>
            <h2>Registry</h2>
            <p>{actionMessage}</p>
          </div>
          <button type="button" className="ghost-btn" onClick={() => setSelectedNodeId(null)}>
            <Plus size={14} /> new
          </button>
        </div>
        <DataTable
          loading={nodes.isLoading}
          empty="No executor nodes have heartbeated yet."
          rows={nodes.data ?? []}
          renderRow={node => (
            <button
              type="button"
              className="record-row node-row"
              data-active={selectedNode?.nodeId === node.nodeId}
              onClick={() => setSelectedNodeId(node.nodeId)}
            >
              <span className="row-title">{node.nodeId}</span>
              <span>{node.nodeKind}</span>
              <span className={`status-text ${node.status}`}>{node.status}</span>
              <span>{resourceCell(node.capacity ?? {})}</span>
              <span>{shortCapFlags(node.capabilities ?? {})}</span>
              <span>{node.connectModes.join(', ') || 'mode?'}</span>
              <span>{node.rolloutState ?? 'idle'}{node.targetVersion ? ` → ${node.targetVersion}` : ''}</span>
              <span>{node.execution.candidate ? 'exec' : 'non-exec'}</span>
              <span>{formatDate(node.lastHeartbeatAt)}</span>
            </button>
          )}
        />
      </div>
      <NodeInspector node={selectedNode as any} />
    </section>
  );
}

function SshImportPanel({ onImported }: { onImported: (message: string) => Promise<void> }) {
  const [content, setContent] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [createMissing, setCreateMissing] = useState(true);
  const [conflictStrategy, setConflictStrategy] = useState<'preserve_existing' | 'overwrite'>('preserve_existing');
  const [result, setResult] = useState<SshConfigImportResponse | null>(null);
  const [busy, setBusy] = useState(false);

  async function importConfig() {
    if (!content.trim()) {
      await onImported('ssh config content is required');
      return;
    }
    setBusy(true);
    try {
      const response = await postJson<SshConfigImportResponse>('/nodes/import-ssh-config', {
        content, dryRun, createMissing, conflictStrategy,
      });
      setResult(response);
      await onImported(`${response.dryRun ? 'previewed' : 'imported'} ${response.summary.total} ssh host entries`);
    } catch (error) {
      await onImported(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-form ssh-import">
      <div className="panel-head compact">
        <h2>SSH Config Import</h2>
        <button type="button" className="ghost-btn" onClick={importConfig} disabled={busy || !content.trim()}>
          <Upload size={14} /> import
        </button>
      </div>
      <div className="field-grid">
        <Field label="content">
          <textarea rows={8} value={content} onChange={event => setContent(event.target.value)} placeholder="Host hh-sgp1-r-t&#10;  HostName 100.86.24.22&#10;  User root&#10;  Port 23452" />
        </Field>
        <div className="import-controls">
          <label className="field-token">
            <input type="checkbox" checked={dryRun} onChange={event => setDryRun(event.target.checked)} /> dry run
          </label>
          <label className="field-token">
            <input type="checkbox" checked={createMissing} onChange={event => setCreateMissing(event.target.checked)} /> create missing
          </label>
          <Field label="conflict">
            <select value={conflictStrategy} onChange={event => setConflictStrategy(event.target.value as 'preserve_existing' | 'overwrite')}>
              <option value="preserve_existing">preserve_existing</option>
              <option value="overwrite">overwrite</option>
            </select>
          </Field>
        </div>
      </div>
      {result ? (
        <div className="import-result">
          <div className="fact-list compact-facts">
            <Fact label="total" value={String(result.summary.total)} />
            <Fact label="create" value={String(result.summary.created)} />
            <Fact label="update" value={String(result.summary.updated)} />
            <Fact label="skip" value={String(result.summary.skipped)} />
            <Fact label="failed" value={String(result.summary.failed)} />
          </div>
          <DataTable
            loading={false}
            empty="No import items."
            rows={result.items}
            renderRow={item => (
              <div className="record-row import-row" key={`${item.alias}:${item.nodeId}`}>
                <span className="row-title">{item.nodeId}</span>
                <span>{item.action}</span>
                <span>{item.hostName}:{item.port}</span>
                <span>{item.user ?? 'user?'}</span>
                <span>{item.error ?? (item.willWrite ? 'write' : 'preview')}</span>
              </div>
            )}
          />
        </div>
      ) : null}
    </div>
  );
}
