import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Network, Save, Radar, Plus, Upload, ArrowDownCircle, ArrowUpCircle, RotateCcw, RefreshCw, Undo2, Info } from 'lucide-react';
import { getJson, patchJson, postJson, type ExecutorNode, type ExecutorNodeUpsertPayload, type SshConfigImportResponse } from './api';
import {
  DataTable,
  Definition,
  EmptyText,
  Fact,
  Field,
  formatDate,
  RefreshQueryButton,
  StatusPill,
} from './ui';

export function NodesPage() {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string>('Registry edits are local until saved.');
  const nodes = useQuery({
    queryKey: ['nodes'],
    queryFn: () => getJson<ExecutorNode[]>('/nodes'),
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
          node={selectedNode}
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
              <span>{node.connectModes.join(', ') || 'mode?'}</span>
              <span>{node.rolloutState ?? 'idle'}{node.targetVersion ? ` → ${node.targetVersion}` : ''}</span>
              <span>{node.execution.candidate ? 'exec' : 'non-exec'}</span>
              <span>{formatDate(node.lastHeartbeatAt)}</span>
            </button>
          )}
        />
      </div>
      <NodeInspector node={selectedNode} />
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
        content,
        dryRun,
        createMissing,
        conflictStrategy,
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
            <input type="checkbox" checked={dryRun} onChange={event => setDryRun(event.target.checked)} />
            dry run
          </label>
          <label className="field-token">
            <input type="checkbox" checked={createMissing} onChange={event => setCreateMissing(event.target.checked)} />
            create missing
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

function NodeEditor({
  node,
  onChangeSelected,
  onSaved,
  onProbed,
}: {
  node: ExecutorNode | null;
  onChangeSelected: (id: string | null) => void;
  onSaved: (message: string) => Promise<void>;
  onProbed: (message: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<NodeDraft>(() => createDraft(null));
  const [busy, setBusy] = useState(false);
  const [commandResult, setCommandResult] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    setDraft(createDraft(node));
    setCommandResult(null);
  }, [node]);

  async function sendCommand(command: string, extraArgs?: Record<string, unknown>) {
    if (!draft.nodeId.trim()) {
      await onProbed('node id is required for command');
      return;
    }
    setBusy(true);
    try {
      const result = await postJson<{ ok: boolean; command: Record<string, unknown> }>(
        `/nodes/${encodeURIComponent(draft.nodeId.trim())}/commands`,
        { command, ...(extraArgs ?? {}) },
      );
      setCommandResult(result);
      const status = (result.command as Record<string, unknown>)?.status ?? 'executed';
      await onProbed(`command ${command}: ${status}`);
    } catch (error) {
      await onProbed(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveNode() {
    if (!draft.nodeId.trim()) {
      await onSaved('node id is required');
      return;
    }
    setBusy(true);
    try {
      const payload = draftToPayload(draft);
      const saved = await patchJson<{ ok: boolean; node: ExecutorNode }>(`/nodes/${encodeURIComponent(draft.nodeId.trim())}`, payload);
      onChangeSelected(saved.node.nodeId);
      await onSaved(`saved ${saved.node.nodeId}`);
    } catch (error) {
      await onSaved(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function probeNode() {
    if (!draft.nodeId.trim()) {
      await onProbed('node id is required for probe');
      return;
    }
    setBusy(true);
    try {
      const result = await postJson<{ ok: boolean; node: ExecutorNode; probe: { status: string; verified: Record<string, unknown>; lastProbeError?: string } }>(`/nodes/${encodeURIComponent(draft.nodeId.trim())}/probe`, {});
      setDraft(createDraft(result.node));
      onChangeSelected(result.node.nodeId);
      await onProbed(result.probe.lastProbeError ? `probe failed: ${result.probe.lastProbeError}` : `probe ok: ${result.node.execution.mode ?? 'unknown'}`);
    } catch (error) {
      await onProbed(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-form node-editor">
      <details className="section-group" open>
        <summary>Identity</summary>
        <div className="field-grid">
          <Field label="node id">
            <input value={draft.nodeId} onChange={event => setDraft(prev => ({ ...prev, nodeId: event.target.value }))} placeholder="node34" />
          </Field>
          <Field label="node kind">
            <select value={draft.nodeKind} onChange={event => setDraft(prev => ({ ...prev, nodeKind: event.target.value as NodeDraft['nodeKind'] }))}>
              <option value="executor">executor</option>
              <option value="ssh_target">ssh_target</option>
              <option value="ingress">ingress</option>
              <option value="proxy">proxy</option>
            </select>
          </Field>
          <Field label="status">
            <select value={draft.status} onChange={event => setDraft(prev => ({ ...prev, status: event.target.value as NodeDraft['status'] }))}>
              <option value="online">online</option>
              <option value="draining">draining</option>
              <option value="offline">offline</option>
            </select>
          </Field>
          <Field label="host label">
            <input value={draft.hostLabel} onChange={event => setDraft(prev => ({ ...prev, hostLabel: event.target.value }))} placeholder="HStorage2" />
          </Field>
          <Field label="base url">
            <input value={draft.baseUrl} onChange={event => setDraft(prev => ({ ...prev, baseUrl: event.target.value }))} placeholder="http://127.0.0.1:8090" />
          </Field>
        </div>
      </details>
      <details className="section-group">
        <summary>Version &amp; Rollout</summary>
        <div className="field-grid">
          <Field label="version">
            <input value={draft.version} onChange={event => setDraft(prev => ({ ...prev, version: event.target.value }))} placeholder="0.1.0" />
          </Field>
          <Field label="target version">
            <input value={draft.targetVersion} onChange={event => setDraft(prev => ({ ...prev, targetVersion: event.target.value }))} placeholder="0.2.0" />
          </Field>
          <Field label="rollout state">
            <select value={draft.rolloutState} onChange={event => setDraft(prev => ({ ...prev, rolloutState: event.target.value as NodeDraft['rolloutState'] }))}>
              <option value="idle">idle</option>
              <option value="draining">draining</option>
              <option value="upgrading">upgrading</option>
              <option value="verifying">verifying</option>
              <option value="failed">failed</option>
            </select>
          </Field>
          <Field label="rollout message">
            <input value={draft.rolloutMessage} onChange={event => setDraft(prev => ({ ...prev, rolloutMessage: event.target.value }))} placeholder="rolling out 0.2.0" />
          </Field>
        </div>
      </details>
      <details className="section-group">
        <summary>Runtime</summary>
        <div className="field-grid">
          <Field label="connect modes">
            <input value={draft.connectModes} onChange={event => setDraft(prev => ({ ...prev, connectModes: event.target.value }))} placeholder="tailscale_ssh, direct_ssh" />
          </Field>
          <Field label="queue depth">
            <input type="number" min={0} value={draft.queueDepth} onChange={event => setDraft(prev => ({ ...prev, queueDepth: event.target.value }))} />
          </Field>
          <Field label="active tasks">
            <input type="number" min={0} value={draft.activeTaskCount} onChange={event => setDraft(prev => ({ ...prev, activeTaskCount: event.target.value }))} />
          </Field>
        </div>
      </details>
      <details className="section-group">
        <summary>Config &amp; Capabilities</summary>
        <div className="field-grid">
          <Field label="connect config">
            <textarea rows={6} value={draft.connectConfig} onChange={event => setDraft(prev => ({ ...prev, connectConfig: event.target.value }))} />
          </Field>
          <Field label="capabilities">
            <textarea rows={6} value={draft.capabilities} onChange={event => setDraft(prev => ({ ...prev, capabilities: event.target.value }))} />
          </Field>
          <Field label="verified">
            <textarea rows={6} value={draft.verified} onChange={event => setDraft(prev => ({ ...prev, verified: event.target.value }))} />
          </Field>
          <Field label="capacity">
            <textarea rows={4} value={draft.capacity} onChange={event => setDraft(prev => ({ ...prev, capacity: event.target.value }))} placeholder='{"maxTasks": 5, "cpuCores": 4}' />
          </Field>
          <Field label="mesh links">
            <textarea rows={6} value={draft.meshLinks} onChange={event => setDraft(prev => ({ ...prev, meshLinks: event.target.value }))} />
          </Field>
        </div>
      </details>
      <div className="toolbar node-editor-actions">
        <button type="button" className="primary-btn" onClick={saveNode} disabled={busy}>
          <Save size={14} /> save
        </button>
        <button type="button" className="ghost-btn" onClick={probeNode} disabled={busy}>
          <Radar size={14} /> probe
        </button>
        <button type="button" className="ghost-btn" onClick={() => sendCommand('drain')} disabled={busy}>
          <ArrowDownCircle size={14} /> drain
        </button>
        <button type="button" className="ghost-btn" onClick={() => sendCommand('promote')} disabled={busy}>
          <ArrowUpCircle size={14} /> promote
        </button>
        <button type="button" className="ghost-btn" onClick={() => sendCommand('restart')} disabled={busy}>
          <RotateCcw size={14} /> restart
        </button>
        <button type="button" className="ghost-btn" onClick={() => sendCommand('upgrade')} disabled={busy}>
          <RefreshCw size={14} /> upgrade
        </button>
        <button type="button" className="ghost-btn" onClick={() => sendCommand('rollback')} disabled={busy}>
          <Undo2 size={14} /> rollback
        </button>
        <button type="button" className="ghost-btn" onClick={() => sendCommand('status')} disabled={busy}>
          <Info size={14} /> status
        </button>
      </div>
      {commandResult ? (
        <div className="json-block">
          <strong>Command Result</strong>
          <pre>{JSON.stringify(commandResult, null, 2)}</pre>
        </div>
      ) : null}
    </div>
  );
}

function NodeInspector({ node }: { node: ExecutorNode | null }) {
  if (!node) {
    return <aside className="panel inspector"><EmptyText text="Select a node to inspect capabilities and verification state." /></aside>;
  }

  return (
    <aside className="panel inspector">
      <div className="panel-head compact">
        <h2>Node Detail</h2>
        <span className="mono-chip">{node.nodeKind}</span>
      </div>
      <div className="fact-list">
        <Fact label="node" value={node.nodeId} />
        <Fact label="host" value={node.hostLabel ?? 'unknown'} />
        <Fact label="base url" value={node.baseUrl ?? 'none'} />
        <Fact label="rollout" value={`${node.rolloutState ?? 'idle'}${node.targetVersion ? ` → ${node.targetVersion}` : ''}`} />
        <Fact label="rollout note" value={node.rolloutMessage ?? 'none'} />
        <Fact label="queue" value={`${node.queueDepth} queued / ${node.activeTaskCount} active`} />
        <Fact label="last heartbeat" value={formatDate(node.lastHeartbeatAt)} />
        <Fact label="last probe" value={node.lastProbeAt ? formatDate(node.lastProbeAt) : 'not probed'} />
        <Fact label="execution" value={node.execution.candidate ? `candidate · ${node.execution.mode ?? 'mode?'}` : 'not candidate'} />
      </div>
      <div className="definition-list">
        <Definition term="executor" text="Can run los-node tasks only when capabilities and lease are valid." />
        <Definition term="ingress" text="Tunnel or callback entry. Ingress is not compute." />
        <Definition term="proxy" text="SOCKS5 or egress path. Proxy is not an executor." />
      </div>
      <div className="definition-list">
        <Definition term="blockers" text={node.execution.blockers.join(', ') || 'none'} />
        <Definition term="warnings" text={node.execution.warnings.join(', ') || 'none'} />
      </div>
      <JsonBlock title="connect config" value={node.connectConfig} />
      <JsonBlock title="capabilities" value={node.capabilities} />
      <JsonBlock title="verified" value={node.verified} />
      <JsonBlock title="mesh links" value={node.meshLinks} />
      <JsonBlock title="capacity" value={node.capacity} />
    </aside>
  );
}

type NodeDraft = {
  nodeId: string;
  nodeKind: ExecutorNode['nodeKind'];
  status: ExecutorNode['status'];
  hostLabel: string;
  baseUrl: string;
  version: string;
  targetVersion: string;
  rolloutState: NonNullable<ExecutorNode['rolloutState']>;
  rolloutMessage: string;
  connectModes: string;
  queueDepth: string;
  activeTaskCount: string;
  connectConfig: string;
  capabilities: string;
  verified: string;
  meshLinks: string;
  capacity: string;
};

function createDraft(node: ExecutorNode | null): NodeDraft {
  return {
    nodeId: node?.nodeId ?? '',
    nodeKind: node?.nodeKind ?? 'executor',
    status: node?.status ?? 'offline',
    hostLabel: node?.hostLabel ?? '',
    baseUrl: node?.baseUrl ?? '',
    version: node?.version ?? '',
    targetVersion: node?.targetVersion ?? '',
    rolloutState: node?.rolloutState ?? 'idle',
    rolloutMessage: node?.rolloutMessage ?? '',
    connectModes: node?.connectModes.join(', ') ?? 'agent_http',
    queueDepth: String(node?.queueDepth ?? 0),
    activeTaskCount: String(node?.activeTaskCount ?? 0),
    connectConfig: stringifyJson(node?.connectConfig ?? {}),
    capabilities: stringifyJson(node?.capabilities ?? { run_agent: false }),
    verified: stringifyJson(node?.verified ?? {}),
    meshLinks: stringifyJson(node?.meshLinks ?? []),
    capacity: stringifyJson(node?.capacity ?? {}),
  };
}

function draftToPayload(draft: NodeDraft): ExecutorNodeUpsertPayload {
  return {
    nodeKind: draft.nodeKind,
    status: draft.status,
    hostLabel: trimOrUndefined(draft.hostLabel),
    baseUrl: trimOrUndefined(draft.baseUrl),
    version: trimOrUndefined(draft.version),
    targetVersion: trimOrUndefined(draft.targetVersion),
    rolloutState: draft.rolloutState,
    rolloutMessage: trimOrUndefined(draft.rolloutMessage),
    connectModes: draft.connectModes
      .split(',')
      .map(item => item.trim())
      .filter(Boolean),
    queueDepth: Number(draft.queueDepth) || 0,
    activeTaskCount: Number(draft.activeTaskCount) || 0,
    connectConfig: parseJsonBlock(draft.connectConfig),
    capabilities: parseJsonBlock(draft.capabilities),
    verified: parseJsonBlock(draft.verified),
    meshLinks: parseJsonArrayBlock(draft.meshLinks),
    capacity: parseJsonBlock(draft.capacity),
  };
}

function parseJsonBlock(value: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseJsonArrayBlock(value: string): Array<Record<string, unknown>> {
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed)
      ? parsed.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as Array<Record<string, unknown>>
      : [];
  } catch {
    return [];
  }
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function trimOrUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="json-block">
      <strong>{title}</strong>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}
