import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
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
import { MCPServerCreate } from './mcp-server-create';

export function MCPServersPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
              <h2>MCP Servers</h2>
              <p>Registered tool servers (stdio, sse, streamable-http). Verify, reload, or remove.</p>
            </div>
          </div>
          <StatusPill status="live" />
        </div>
        <DataTable
          loading={servers.isLoading}
          empty="No MCP servers registered."
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
              <span>{server.enabled ? 'enabled' : 'disabled'}</span>
              <span>{server.toolCount} tools</span>
              <span>{formatDate(server.updatedAt)}</span>
            </button>
          )}
        />
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
        <h2>Server Detail</h2>
        <span className="mono-chip">{server.id}</span>
      </div>
      <div className="fact-list compact-facts">
        <Fact label="transport" value={server.transport} />
        <Fact label="status" value={server.status} />
        <Fact label="tools" value={String(server.toolCount)} />
        <Fact label="enabled" value={String(server.enabled)} />
        <Fact label="source" value={server.sourceUri || 'manual'} />
        <Fact label="version" value={server.versionHash.slice(0, 12)} />
        <Fact label="pinned" value={server.pinnedVersionHash?.slice(0, 12) || 'no'} />
        <Fact label="auth" value={server.authConfig.mode} />
        <Fact label="risk" value={server.toolPolicy.riskLevel} />
        <Fact label="updated" value={formatDate(server.updatedAt)} />
      </div>
      {server.command ? <Fact label="command" value={server.command} /> : null}
      {server.url ? <Fact label="url" value={server.url} /> : null}
      {server.args.length > 0 ? <Fact label="args" value={server.args.join(' ')} /> : null}
      {server.authConfig.credentialRef ? <Fact label="credential ref" value={server.authConfig.credentialRef} /> : null}
      {server.toolPolicy.allow.length > 0 ? <Fact label="allowed tools" value={server.toolPolicy.allow.join(', ')} /> : null}
      {server.toolPolicy.deny.length > 0 ? <Fact label="denied tools" value={server.toolPolicy.deny.join(', ')} /> : null}
      {server.lastError ? (
        <div className="definition-list">
          <Definition term="last error" text={server.lastError} />
        </div>
      ) : null}
      {server.tools.length > 0 ? (
        <div className="definition-list">
          {server.tools.map(tool => (
            <Definition key={tool.name} term={tool.name} text={tool.description ?? 'no description'} />
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
          <CheckCircle2 size={14} /> verify
        </button>
        <button
          className="ghost-btn"
          type="button"
          disabled={enable.isPending || (!server.enabled && server.status !== 'connected')}
          onClick={() => enable.mutate(!server.enabled)}
        >
          <Power size={14} /> {server.enabled ? 'disable' : 'enable'}
        </button>
        <button
          className="ghost-btn"
          type="button"
          disabled={pin.isPending}
          onClick={() => pin.mutate(!server.pinnedVersionHash)}
        >
          {server.pinnedVersionHash ? <PinOff size={14} /> : <Pin size={14} />}
          {server.pinnedVersionHash ? 'unpin' : 'pin'}
        </button>
        <button
          className="ghost-btn"
          type="button"
          disabled={reload.isPending}
          onClick={() => reload.mutate(server.id)}
        >
          <RefreshCcw size={14} /> reload
        </button>
        <button
          className="ghost-btn"
          type="button"
          disabled={remove.isPending}
          onClick={() => remove.mutate(server.id)}
        >
          <Trash2 size={14} /> delete
        </button>
      </div>
      {verify.data ? (
        <div className="json-block">
          <strong>Verify Result</strong>
          <pre>{JSON.stringify(verify.data, null, 2)}</pre>
        </div>
      ) : null}
      {reload.data ? (
        <div className="json-block">
          <strong>Reload Result</strong>
          <pre>{JSON.stringify(reload.data, null, 2)}</pre>
        </div>
      ) : null}
      {(history.data?.versions.length ?? 0) > 1 ? (
        <div className="definition-list">
          {history.data!.versions.map(version => (
            <div className="definition" key={version.versionHash}>
              <strong>{version.versionHash.slice(0, 12)}</strong>
              {version.versionHash === server.versionHash ? <span>current</span> : (
                <button
                  className="icon-btn"
                  type="button"
                  title="Rollback to this version"
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
