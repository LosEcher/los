import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Save, Radar, ArrowDownCircle, ArrowUpCircle, RotateCcw, RefreshCw, Undo2, Info } from 'lucide-react';
import { getJson, patchJson, postJson, type ExecutorNode, type ExecutorNodeUpsertPayload } from './api';
import { Fact, Field, formatDate, Definition, EmptyText } from './ui';
import { useI18n } from './i18n';

export function fmtMb(value: unknown): string {
  if (typeof value !== 'number' || !isFinite(value) || value <= 0) return '?';
  if (value >= 1024) return `${Math.round(value / 1024)}GB`;
  return `${value}MB`;
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

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
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
    connectModes: draft.connectModes.split(',').map(item => item.trim()).filter(Boolean),
    queueDepth: Number(draft.queueDepth) || 0,
    activeTaskCount: Number(draft.activeTaskCount) || 0,
    connectConfig: parseJsonBlock(draft.connectConfig),
    capabilities: parseJsonBlock(draft.capabilities),
    verified: parseJsonBlock(draft.verified),
    meshLinks: parseJsonArrayBlock(draft.meshLinks),
    capacity: parseJsonBlock(draft.capacity),
  };
}

export function NodeEditor({
  node, onChangeSelected, onSaved, onProbed,
}: {
  node: ExecutorNode | null;
  onChangeSelected: (id: string | null) => void;
  onSaved: (message: string) => Promise<void>;
  onProbed: (message: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<NodeDraft>(() => createDraft(null));
  const [busy, setBusy] = useState(false);
  const [commandResult, setCommandResult] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    setDraft(createDraft(node));
    setCommandResult(null);
  }, [node]);

  async function sendCommand(command: string, extraArgs?: Record<string, unknown>) {
    if (!draft.nodeId.trim()) {
      await onProbed(t('assets.node.nodeIdRequiredCommand'));
      return;
    }
    setBusy(true);
    try {
      const result = await postJson<{ ok: boolean; command: Record<string, unknown> }>(
        `/nodes/${encodeURIComponent(draft.nodeId.trim())}/commands`,
        { command, ...(extraArgs ?? {}) },
      );
      setCommandResult(result);
      const status = (result.command as Record<string, unknown>)?.status ?? t('assets.node.executed');
      await onProbed(t('assets.node.commandResult', { command, status: String(status) }));
    } catch (error) {
      await onProbed(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveNode() {
    if (!draft.nodeId.trim()) {
      await onSaved(t('assets.node.nodeIdRequired'));
      return;
    }
    setBusy(true);
    try {
      const payload = draftToPayload(draft);
      const saved = await patchJson<{ ok: boolean; node: ExecutorNode }>(`/nodes/${encodeURIComponent(draft.nodeId.trim())}`, payload);
      onChangeSelected(saved.node.nodeId);
      await onSaved(t('assets.node.saved', { nodeId: saved.node.nodeId }));
    } catch (error) {
      await onSaved(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function probeNode() {
    if (!draft.nodeId.trim()) {
      await onProbed(t('assets.node.nodeIdRequiredProbe'));
      return;
    }
    setBusy(true);
    try {
      const result = await postJson<{ ok: boolean; node: ExecutorNode; probe: { status: string; verified: Record<string, unknown>; lastProbeError?: string } }>(`/nodes/${encodeURIComponent(draft.nodeId.trim())}/probe`, {});
      setDraft(createDraft(result.node));
      onChangeSelected(result.node.nodeId);
      await onProbed(result.probe.lastProbeError
        ? t('assets.node.probeFailed', { error: result.probe.lastProbeError })
        : t('assets.node.probeOk', { mode: result.node.execution.mode ?? t('common.unknown') }));
    } catch (error) {
      await onProbed(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-form node-editor">
      <details className="section-group" open>
        <summary>{t('assets.node.identity')}</summary>
        <div className="field-grid">
          <Field label={t('assets.label.nodeId')}>
            <input value={draft.nodeId} onChange={event => setDraft(prev => ({ ...prev, nodeId: event.target.value }))} placeholder="node34" />
          </Field>
          <Field label={t('assets.label.nodeKind')}>
            <select value={draft.nodeKind} onChange={event => setDraft(prev => ({ ...prev, nodeKind: event.target.value as NodeDraft['nodeKind'] }))}>
              <option value="executor">executor</option>
              <option value="ssh_target">ssh_target</option>
              <option value="ingress">ingress</option>
              <option value="proxy">proxy</option>
            </select>
          </Field>
          <Field label={t('assets.label.status')}>
            <select value={draft.status} onChange={event => setDraft(prev => ({ ...prev, status: event.target.value as NodeDraft['status'] }))}>
              <option value="online">online</option>
              <option value="draining">draining</option>
              <option value="offline">offline</option>
            </select>
          </Field>
          <Field label={t('assets.label.hostLabel')}>
            <input value={draft.hostLabel} onChange={event => setDraft(prev => ({ ...prev, hostLabel: event.target.value }))} placeholder="HStorage2" />
          </Field>
          <Field label={t('assets.label.baseUrl')}>
            <input value={draft.baseUrl} onChange={event => setDraft(prev => ({ ...prev, baseUrl: event.target.value }))} placeholder="http://127.0.0.1:8090" />
          </Field>
        </div>
      </details>
      <details className="section-group">
        <summary>{t('assets.node.versionRollout')}</summary>
        <div className="field-grid">
          <Field label={t('assets.label.version')}>
            <input value={draft.version} onChange={event => setDraft(prev => ({ ...prev, version: event.target.value }))} placeholder="0.1.0" />
          </Field>
          <Field label={t('assets.label.targetVersion')}>
            <input value={draft.targetVersion} onChange={event => setDraft(prev => ({ ...prev, targetVersion: event.target.value }))} placeholder="0.2.0" />
          </Field>
          <Field label={t('assets.label.rolloutState')}>
            <select value={draft.rolloutState} onChange={event => setDraft(prev => ({ ...prev, rolloutState: event.target.value as NodeDraft['rolloutState'] }))}>
              <option value="idle">idle</option>
              <option value="draining">draining</option>
              <option value="upgrading">upgrading</option>
              <option value="verifying">verifying</option>
              <option value="failed">failed</option>
            </select>
          </Field>
          <Field label={t('assets.label.rolloutMessage')}>
            <input value={draft.rolloutMessage} onChange={event => setDraft(prev => ({ ...prev, rolloutMessage: event.target.value }))} placeholder={t('assets.node.rolloutMessagePh')} />
          </Field>
        </div>
      </details>
      <details className="section-group">
        <summary>{t('assets.node.runtime')}</summary>
        <div className="field-grid">
          <Field label={t('assets.label.connectModes')}>
            <input value={draft.connectModes} onChange={event => setDraft(prev => ({ ...prev, connectModes: event.target.value }))} placeholder="tailscale_ssh, direct_ssh" />
          </Field>
          <Field label={t('assets.label.queueDepth')}>
            <input type="number" min={0} value={draft.queueDepth} onChange={event => setDraft(prev => ({ ...prev, queueDepth: event.target.value }))} />
          </Field>
          <Field label={t('assets.label.activeTasks')}>
            <input type="number" min={0} value={draft.activeTaskCount} onChange={event => setDraft(prev => ({ ...prev, activeTaskCount: event.target.value }))} />
          </Field>
        </div>
      </details>
      <details className="section-group">
        <summary>{t('assets.node.configCapabilities')}</summary>
        <div className="field-grid">
          <Field label={t('assets.label.connectConfig')}>
            <textarea rows={6} value={draft.connectConfig} onChange={event => setDraft(prev => ({ ...prev, connectConfig: event.target.value }))} />
          </Field>
          <Field label={t('assets.label.capabilities')}>
            <textarea rows={6} value={draft.capabilities} onChange={event => setDraft(prev => ({ ...prev, capabilities: event.target.value }))} />
          </Field>
          <Field label={t('assets.label.verified')}>
            <textarea rows={6} value={draft.verified} onChange={event => setDraft(prev => ({ ...prev, verified: event.target.value }))} />
          </Field>
          <Field label={t('assets.label.capacity')}>
            <textarea rows={4} value={draft.capacity} onChange={event => setDraft(prev => ({ ...prev, capacity: event.target.value }))} placeholder='{"maxTasks": 5, "cpuCores": 4}' />
          </Field>
          <Field label={t('assets.label.meshLinks')}>
            <textarea rows={6} value={draft.meshLinks} onChange={event => setDraft(prev => ({ ...prev, meshLinks: event.target.value }))} />
          </Field>
        </div>
      </details>
      <div className="toolbar node-editor-actions">
        <button type="button" className="primary-btn" onClick={saveNode} disabled={busy}>
          <Save size={14} /> {t('common.save')}
        </button>
        <button type="button" className="ghost-btn" onClick={probeNode} disabled={busy}>
          <Radar size={14} /> {t('assets.node.probe')}
        </button>
        <button type="button" className="ghost-btn" onClick={() => sendCommand('drain')} disabled={busy}>
          <ArrowDownCircle size={14} /> {t('assets.node.drain')}
        </button>
        <button type="button" className="ghost-btn" onClick={() => sendCommand('promote')} disabled={busy}>
          <ArrowUpCircle size={14} /> {t('assets.node.promote')}
        </button>
        <button type="button" className="ghost-btn" onClick={() => sendCommand('restart')} disabled={busy}>
          <RotateCcw size={14} /> {t('assets.node.restart')}
        </button>
        <button type="button" className="ghost-btn" onClick={() => sendCommand('upgrade')} disabled={busy}>
          <RefreshCw size={14} /> {t('assets.node.upgrade')}
        </button>
        <button type="button" className="ghost-btn" onClick={() => sendCommand('rollback')} disabled={busy}>
          <Undo2 size={14} /> {t('assets.node.rollback')}
        </button>
        <button type="button" className="ghost-btn" onClick={() => sendCommand('status')} disabled={busy}>
          <Info size={14} /> {t('assets.label.status')}
        </button>
      </div>
      {commandResult ? (
        <div className="json-block">
          <strong>{t('assets.node.commandResultTitle')}</strong>
          <pre>{JSON.stringify(commandResult, null, 2)}</pre>
        </div>
      ) : null}
    </div>
  );
}

export function NodeInspector({ node }: { node: ExecutorNode | null }) {
  const { t } = useI18n();
  const nodeCommands = useQuery({
    queryKey: ['node-commands', node?.nodeId],
    queryFn: () => getJson<Array<{ id: string; command: string; status: string; createdAt: string; result?: Record<string, unknown> }>>(`/nodes/${encodeURIComponent(node!.nodeId)}/commands`),
    enabled: Boolean(node?.nodeId),
    refetchInterval: 15_000,
  });

  if (!node) {
    return <aside className="panel inspector"><EmptyText text={t('assets.node.selectHint')} /></aside>;
  }

  return (
    <aside className="panel inspector">
      <div className="panel-head compact">
        <h2>{t('assets.node.detailTitle')}</h2>
        <span className="mono-chip">{node.nodeKind}</span>
      </div>
      <div className="fact-list">
        <Fact label={t('assets.label.node')} value={node.nodeId} />
        <Fact label={t('assets.label.host')} value={node.hostLabel ?? t('common.unknown')} />
        <Fact label={t('assets.label.baseUrl')} value={node.baseUrl ?? t('common.none')} />
        <Fact label={t('assets.label.resourceClass')} value={typeof node.capabilities?.deploy_safe === 'boolean'
          ? (node.capabilities.heavy_task_safe ? t('assets.node.resourceStandard') : t('assets.node.resourceConstrained'))
          : (node.capabilities as Record<string, unknown>).resourceClass as string ?? '?'} />
        <Fact label={t('assets.label.memory')} value={t('assets.node.memoryValue', {
          total: fmtMb((node.capacity as Record<string, unknown>)?.memoryTotalMb),
          avail: fmtMb((node.capacity as Record<string, unknown>)?.memoryAvailableMb),
        })} />
        <Fact label={t('assets.label.swap')} value={typeof (node.capacity as Record<string, unknown>)?.swapTotalMb === 'number'
          ? t('assets.node.swapValue', {
              total: fmtMb((node.capacity as Record<string, unknown>)?.swapTotalMb),
              used: fmtMb((node.capacity as Record<string, unknown>)?.swapUsedMb),
            })
          : '?'} />
        <Fact label={t('assets.label.rollout')} value={`${node.rolloutState ?? 'idle'}${node.targetVersion ? t('assets.node.rolloutTarget', { version: node.targetVersion }) : ''}`} />
        <Fact label={t('assets.label.rolloutNote')} value={node.rolloutMessage ?? t('common.none')} />
        <Fact label={t('assets.label.queue')} value={t('assets.node.queueValue', { queued: node.queueDepth, active: node.activeTaskCount })} />
        <Fact label={t('assets.label.lastHeartbeat')} value={formatDate(node.lastHeartbeatAt)} />
        <Fact label={t('assets.label.lastProbe')} value={node.lastProbeAt ? formatDate(node.lastProbeAt) : t('assets.node.notProbed')} />
        <Fact label={t('assets.label.execution')} value={node.execution.candidate ? t('assets.node.executionCandidate', { mode: node.execution.mode ?? t('assets.state.modeUnknown') }) : t('assets.node.notCandidate')} />
      </div>
      <div className="definition-list">
        <Definition term={t('assets.node.defExecutor')} text={t('assets.node.defExecutorText')} />
        <Definition term={t('assets.node.defIngress')} text={t('assets.node.defIngressText')} />
        <Definition term={t('assets.node.defProxy')} text={t('assets.node.defProxyText')} />
      </div>
      <div className="definition-list">
        <Definition term={t('assets.label.blockers')} text={node.execution.blockers.join(', ') || t('common.none')} />
        <Definition term={t('assets.label.warnings')} text={node.execution.warnings.join(', ') || t('common.none')} />
      </div>
      <JsonBlock title={t('assets.label.connectConfig')} value={node.connectConfig} />
      <JsonBlock title={t('assets.label.capabilities')} value={node.capabilities} />
      <JsonBlock title={t('assets.label.verified')} value={node.verified} />
      <JsonBlock title={t('assets.label.meshLinks')} value={node.meshLinks} />
      <JsonBlock title={t('assets.label.capacity')} value={node.capacity} />
      {nodeCommands.data && nodeCommands.data.length > 0 ? (
        <div className="definition-list">
          <div className="section-divider"><strong>{t('assets.node.commandHistory')}</strong></div>
          {(nodeCommands.data ?? []).slice(-8).reverse().map(cmd => (
            <Definition
              key={cmd.id}
              term={`${cmd.command} · ${cmd.status}`}
              text={formatDate(cmd.createdAt)}
            />
          ))}
        </div>
      ) : null}
    </aside>
  );
}

export function JsonBlock({ title, value }: { title: string; value: unknown }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const json = JSON.stringify(value, null, 2);
  const isEmpty = json === '{}' || json === '[]' || json === '""' || json === 'null';
  return (
    <div className="json-block">
      <button type="button" className="json-toggle" onClick={() => setOpen(!open)}>
        <strong>{open ? '▾' : '▸'} {title}</strong>
        {!open ? <span className="json-preview">{isEmpty ? t('assets.node.emptyJson') : json.slice(0, 80).replace(/\n/g, ' ')}</span> : null}
      </button>
      {open ? <pre>{json}</pre> : null}
    </div>
  );
}
