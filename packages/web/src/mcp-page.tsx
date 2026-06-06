import { type FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Plus,
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
  type MCPServerListResponse,
  type MCPServerVerifyResponse,
  type MCPTransport,
} from './api';
import {
  DataTable,
  Definition,
  EmptyText,
  Fact,
  Field,
  formatDate,
  StatusPill,
} from './ui';

const TRANSPORTS: MCPTransport[] = ['stdio', 'sse', 'streamable-http'];

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
        <Fact label="updated" value={formatDate(server.updatedAt)} />
      </div>
      {server.command ? <Fact label="command" value={server.command} /> : null}
      {server.url ? <Fact label="url" value={server.url} /> : null}
      {server.args.length > 0 ? <Fact label="args" value={server.args.join(' ')} /> : null}
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
    </>
  );
}

function MCPServerCreate({ onCreated }: { onCreated: (id: string) => void }) {
  const [id, setId] = useState('');
  const [transport, setTransport] = useState<MCPTransport>('stdio');
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!id.trim()) return;
    setBusy(true);
    setError('');
    try {
      const body: Record<string, unknown> = {
        id: id.trim(),
        transport,
        enabled,
      };
      if (transport === 'stdio') {
        body.command = command.trim() || undefined;
        body.args = args.trim() ? args.split(',').map(s => s.trim()).filter(Boolean) : undefined;
      } else {
        body.url = url.trim() || undefined;
      }
      if (env.trim()) {
        try { body.env = JSON.parse(env.trim()); } catch { setError('env must be valid JSON'); setBusy(false); return; }
      }
      const created = await postJson<MCPServer>('/mcp-servers', body);
      setId(''); setCommand(''); setUrl(''); setArgs(''); setEnv('');
      onCreated(created.id);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="panel-head compact">
        <h2>Add MCP Server</h2>
      </div>
      <form className="stack-form" onSubmit={handleSubmit}>
        <Field label="server id">
          <input value={id} onChange={e => setId(e.target.value)} placeholder="my-mcp-server" />
        </Field>
        <Field label="transport">
          <select value={transport} onChange={e => setTransport(e.target.value as MCPTransport)}>
            {TRANSPORTS.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        {transport === 'stdio' ? (
          <>
            <Field label="command">
              <input value={command} onChange={e => setCommand(e.target.value)} placeholder="npx -y @modelcontextprotocol/server-filesystem" />
            </Field>
            <Field label="args (comma-separated)">
              <input value={args} onChange={e => setArgs(e.target.value)} placeholder="/path/to/allowed" />
            </Field>
          </>
        ) : (
          <Field label="url">
            <input value={url} onChange={e => setUrl(e.target.value)} placeholder="http://localhost:3001/mcp" />
          </Field>
        )}
        <Field label="env (JSON)">
          <textarea value={env} onChange={e => setEnv(e.target.value)} rows={3} placeholder='{"API_KEY": "..."}' />
        </Field>
        <label className="toolbar-toggle">
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
          enabled
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <button className="primary-btn" type="submit" disabled={!id.trim() || busy}>
          <Plus size={14} /> register
        </button>
      </form>
    </>
  );
}
