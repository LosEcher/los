import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Lock,
  Pin,
  PinOff,
  Power,
  RefreshCcw,
  RotateCcw,
  Server,
  Trash2,
} from 'lucide-react';
import {
  deleteJson,
  getJson,
  postJson,
  type MCPServer,
  type MCPHistoryResponse,
  type MCPServerListResponse,
  type MCPServerVerifyResponse,
} from './api';
import {
  DataTable,
  Definition,
  EmptyText,
  Fact,
  formatDate,
  StatusPill,
} from './ui';
import { useI18n } from './i18n';
import { MCPServerCreate } from './mcp-server-create';

type T = ReturnType<typeof useI18n>['t'];

export function MCPServersPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { t } = useI18n();

  const servers = useQuery({
    queryKey: ['mcp-servers'],
    queryFn: () => getJson<MCPServerListResponse>('/mcp-servers'),
    refetchInterval: 12_000,
  });

  const list = servers.data?.servers ?? [];
  const selected = list.find(s => s.id === selectedId) ?? null;

  return (
    <section className="panel-grid detail-grid">
      <div className="panel">
        <div className="panel-head">
          <div className="title-row">
            <Server size={18} />
            <div>
              <h2>{t('assets.mcp.serversTitle')}</h2>
              <p>{t('assets.mcp.serversSubtitle')}</p>
            </div>
          </div>
          <StatusPill status="live" />
        </div>
        <DataTable
          loading={servers.isLoading}
          empty={t('assets.mcp.emptyList')}
          rows={list}
          renderRow={server => (
            <button
              type="button"
              className="record-row"
              data-active={selected?.id === server.id}
              onClick={() => setSelectedId(server.id)}
            >
              <span className="row-title">{server.id}</span>
              <span>{server.transport}</span>
              <span className={`status-text ${server.status}`}>{server.status}</span>
              <span>{server.enabled ? t('common.enabled') : t('common.disabled')}</span>
              <span>{capabilityCountLabel(server, t)}</span>
              <span>{formatDate(server.updatedAt)}</span>
            </button>
          )}
        />
        {list.length === 0 && !servers.isLoading ? (
          <div className="empty-guide">
            <p>{t('assets.mcp.emptyGuidePre')} <code>los mcp import</code> {t('assets.mcp.emptyGuidePost')}</p>
          </div>
        ) : null}
      </div>

      <aside className="panel inspector">
        {selected ? (
          <MCPServerInspector
            server={selected}
            onRefresh={() => queryClient.invalidateQueries({ queryKey: ['mcp-servers'] })}
            onSelect={(id) => setSelectedId(id)}
          />
        ) : (
          <MCPServerCreate
            onCreated={(id) => {
              setSelectedId(id);
              queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
            }}
          />
        )}
      </aside>
    </section>
  );
}

function MCPServerInspector({
  server,
  onRefresh,
  onSelect,
}: {
  server: MCPServer;
  onRefresh: () => void;
  onSelect: (id: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const history = useQuery({
    queryKey: ['mcp-server-history', server.id],
    queryFn: () => getJson<MCPHistoryResponse>(`/mcp-servers/${encodeURIComponent(server.id)}/history`),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteJson(`/mcp-servers/${id}`),
    onSuccess: () => {
      onSelect(null);
      queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
    },
  });

  const verify = useMutation({
    mutationFn: (id: string) => postJson<MCPServerVerifyResponse>(`/mcp-servers/${id}/verify`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
    },
  });

  const reload = useMutation({
    mutationFn: (id: string) => postJson<MCPServerVerifyResponse>(`/mcp-servers/${id}/reload`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
    },
  });

  const enable = useMutation({
    mutationFn: (enabled: boolean) => postJson<MCPServer>(`/mcp-servers/${encodeURIComponent(server.id)}/enable`, { enabled }),
    onSuccess: onRefresh,
  });

  const pin = useMutation({
    mutationFn: (pinned: boolean) => postJson<MCPServer>(`/mcp-servers/${encodeURIComponent(server.id)}/pin`, { pinned }),
    onSuccess: () => {
      onRefresh();
      queryClient.invalidateQueries({ queryKey: ['mcp-server-history', server.id] });
    },
  });

  const rollback = useMutation({
    mutationFn: (versionHash: string) => postJson<MCPServer>(`/mcp-servers/${encodeURIComponent(server.id)}/rollback`, { versionHash }),
    onSuccess: () => {
      onRefresh();
      queryClient.invalidateQueries({ queryKey: ['mcp-server-history', server.id] });
    },
  });

  return (
    <>
      <div className="panel-head compact">
        <h2>{t('assets.mcp.serverDetailTitle')}</h2>
        <span className="mono-chip">{server.id}</span>
      </div>
      <div className="fact-list compact-facts">
        <Fact label={t('assets.label.transport')} value={server.transport} />
        <Fact label={t('assets.label.status')} value={server.status} />
        <Fact label={t('assets.label.tools')} value={String(server.toolCount)} />
        <Fact label={t('common.enabled')} value={String(server.enabled)} />
        <Fact label={t('assets.label.source')} value={server.sourceUri || t('assets.state.manual')} />
        <Fact label={t('assets.label.version')} value={server.versionHash.slice(0, 12)} />
        <Fact label={t('assets.label.pinned')} value={server.pinnedVersionHash?.slice(0, 12) || t('assets.state.no')} />
        <Fact label={t('assets.label.auth')} value={server.authConfig.mode} />
        <Fact label={t('assets.label.risk')} value={server.toolPolicy.riskLevel} />
        <Fact label={t('assets.label.adapter')} value={server.adapterConfig.kind} />
        {server.adapterConfig.kind === 'cantool' ? (
          <>
            <Fact label={t('assets.mcp.providerLocation')} value={server.adapterConfig.providerLocation} />
            <Fact label={t('assets.mcp.dataGrantOwner')} value={server.adapterConfig.dataGrantOwner} />
            <Fact label={t('assets.mcp.sessionBinding')} value={server.adapterConfig.sessionBinding} />
          </>
        ) : null}
        {server.adapterEvidence?.serverVersion ? <Fact label={t('assets.mcp.serverVersion')} value={server.adapterEvidence.serverVersion} /> : null}
        {server.adapterEvidence?.protocolVersion ? <Fact label={t('assets.mcp.protocol')} value={server.adapterEvidence.protocolVersion} /> : null}
        {server.adapterEvidence?.capabilitySummary ? (
          <Fact
            label={t('assets.label.capabilities')}
            value={t('assets.mcp.capabilitiesBlocked', {
              available: server.adapterEvidence.capabilitySummary.available,
              blocked: server.adapterEvidence.capabilitySummary.blocked,
            })}
          />
        ) : null}
        <Fact label={t('assets.label.updated')} value={formatDate(server.updatedAt)} />
      </div>
      {server.command ? <Fact label={t('assets.label.command')} value={server.command} /> : null}
      {server.url ? <Fact label={t('assets.label.url')} value={server.url} /> : null}
      {server.args.length > 0 ? <Fact label={t('assets.label.args')} value={server.args.join(' ')} /> : null}
      {server.authConfig.credentialRef ? <Fact label={t('assets.mcp.credentialRef')} value={server.authConfig.credentialRef} /> : null}
      {server.toolPolicy.allow.length > 0 ? <Fact label={t('assets.mcp.allowedTools')} value={server.toolPolicy.allow.join(', ')} /> : null}
      {server.toolPolicy.deny.length > 0 ? <Fact label={t('assets.mcp.deniedTools')} value={server.toolPolicy.deny.join(', ')} /> : null}
      {server.lastError ? (
        <div className="definition-list">
          <Definition term={t('assets.mcp.lastError')} text={server.lastError} />
        </div>
      ) : null}
      {server.tools.length > 0 ? (
        <div className="definition-list">
          {server.tools.map(tool => (
            <MCPToolRow key={tool.name} tool={tool} t={t} />
          ))}
        </div>
      ) : null}
      <div className="inline-actions">
        <button
          className="ghost-btn"
          type="button"
          disabled={verify.isPending}
          onClick={() => verify.mutate(server.id)}
        >
          <CheckCircle2 size={14} /> {t('assets.mcp.verify')}
        </button>
        <button
          className="ghost-btn"
          type="button"
          disabled={enable.isPending || (!server.enabled && server.status !== 'connected')}
          onClick={() => enable.mutate(!server.enabled)}
        >
          <Power size={14} /> {server.enabled ? t('assets.mcp.disable') : t('assets.mcp.enable')}
        </button>
        <button
          className="ghost-btn"
          type="button"
          disabled={pin.isPending}
          onClick={() => pin.mutate(!server.pinnedVersionHash)}
        >
          {server.pinnedVersionHash ? <PinOff size={14} /> : <Pin size={14} />}
          {server.pinnedVersionHash ? t('assets.mcp.unpin') : t('assets.mcp.pin')}
        </button>
        <button
          className="ghost-btn"
          type="button"
          disabled={reload.isPending}
          onClick={() => reload.mutate(server.id)}
        >
          <RefreshCcw size={14} /> {t('assets.mcp.reload')}
        </button>
        <button
          className="ghost-btn"
          type="button"
          disabled={remove.isPending}
          onClick={() => remove.mutate(server.id)}
        >
          <Trash2 size={14} /> {t('common.delete')}
        </button>
      </div>
      {verify.data ? (
        <div className="json-block">
          <strong>{t('assets.mcp.verifyResult')}</strong>
          <pre>{JSON.stringify(verify.data, null, 2)}</pre>
        </div>
      ) : null}
      {reload.data ? (
        <div className="json-block">
          <strong>{t('assets.mcp.reloadResult')}</strong>
          <pre>{JSON.stringify(reload.data, null, 2)}</pre>
        </div>
      ) : null}
      {(history.data?.versions.length ?? 0) > 1 ? (
        <div className="definition-list">
          {history.data!.versions.map(version => (
            <div className="definition" key={version.versionHash}>
              <strong>{version.versionHash.slice(0, 12)}</strong>
              {version.versionHash === server.versionHash ? <span>{t('assets.state.current')}</span> : (
                <button
                  className="icon-btn"
                  type="button"
                  title={t('assets.mcp.rollbackTitle')}
                  disabled={rollback.isPending || Boolean(server.pinnedVersionHash && server.pinnedVersionHash !== version.versionHash)}
                  onClick={() => rollback.mutate(version.versionHash)}
                ><RotateCcw size={14} /></button>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function capabilityCountLabel(server: MCPServer, t: T): string {
  const summary = server.adapterEvidence?.capabilitySummary;
  return summary
    ? t('assets.mcp.capabilitiesAvailable', { available: summary.available, projected: summary.projected })
    : t('assets.mcp.toolsCount', { count: server.toolCount });
}

function MCPToolRow({ tool, t }: { tool: MCPServer['tools'][number]; t: T }) {
  const capability = tool.capability;
  if (!capability || capability.availability !== 'blocked') {
    return <Definition term={tool.name} text={toolDescription(tool, t)} />;
  }
  return (
    <div className="definition tool-blocked">
      <strong>
        <Lock size={12} className="tool-lock-icon" aria-hidden="true" />
        {tool.name}
      </strong>
      <span className="tool-block-reason">
        {t('assets.mcp.blockedReason', { reason: capability.reason })}
      </span>
      <span className="tool-block-meta">
        {t('assets.mcp.capabilityDetail', {
          classification: capability.dataClassification,
          description: tool.description ?? t('assets.state.noDescription'),
        })}
      </span>
    </div>
  );
}

function toolDescription(tool: MCPServer['tools'][number], t: T): string {
  const capability = tool.capability;
  if (!capability) return tool.description ?? t('assets.state.noDescription');
  const status = capability.availability === 'available'
    ? t('assets.state.available')
    : t('assets.mcp.blockedReason', { reason: capability.reason });
  return t('assets.mcp.capabilitySummary', {
    status,
    classification: capability.dataClassification,
    description: tool.description ?? t('assets.state.noDescription'),
  });
}
