import { type FormEvent, useState } from 'react';
import { Eye, Plus } from 'lucide-react';
import { postJson, type MCPInspection, type MCPServer, type MCPTransport } from './api';
import { Definition, Field } from './ui';

const TRANSPORTS: MCPTransport[] = ['stdio', 'sse', 'streamable-http'];

export function MCPServerCreate({ onCreated }: { onCreated: (id: string) => void }) {
  const [id, setId] = useState('');
  const [transport, setTransport] = useState<MCPTransport>('stdio');
  const [adapterKind, setAdapterKind] = useState<'generic' | 'cantool'>('generic');
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
  const [args, setArgs] = useState('');
  const [sourceUri, setSourceUri] = useState('');
  const [authMode, setAuthMode] = useState<'none' | 'credential_ref' | 'oauth'>('none');
  const [credentialRef, setCredentialRef] = useState('');
  const [allowTools, setAllowTools] = useState('');
  const [denyTools, setDenyTools] = useState('');
  const [riskLevel, setRiskLevel] = useState<'L0' | 'L1' | 'L2'>('L1');
  const [inspection, setInspection] = useState<(MCPInspection & { draftKey: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function draftBody(): Record<string, unknown> {
    return {
      id: id.trim(), transport,
      command: transport === 'stdio' ? command.trim() || undefined : undefined,
      args: transport === 'stdio' ? args.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      url: transport !== 'stdio' ? url.trim() || undefined : undefined,
      sourceUri: sourceUri.trim() || undefined,
      authConfig: { mode: authMode, credentialRef: authMode === 'none' ? undefined : credentialRef.trim() || undefined },
      toolPolicy: {
        allow: allowTools.split(',').map(s => s.trim()).filter(Boolean),
        deny: denyTools.split(',').map(s => s.trim()).filter(Boolean),
        riskLevel,
      },
      adapterConfig: { kind: adapterKind },
    };
  }

  async function handleInspect() {
    if (!id.trim()) return;
    setBusy(true); setError('');
    try {
      const body = draftBody();
      const result = await postJson<MCPInspection>('/mcp-servers/inspect', body);
      setInspection({ ...result, draftKey: JSON.stringify(body) });
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally { setBusy(false); }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!id.trim()) return;
    setBusy(true); setError('');
    try {
      const draft = draftBody();
      if (!inspection || inspection.draftKey !== JSON.stringify(draft)) {
        setError('Inspect the current registration before applying it');
        return;
      }
      const created = await postJson<MCPServer>('/mcp-servers', {
        ...inspection.normalized,
        inspectedVersionHash: inspection.versionHash,
      });
      setId(''); setCommand(''); setUrl(''); setArgs(''); setSourceUri(''); setCredentialRef(''); setInspection(null);
      onCreated(created.id);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="panel-head compact"><h2>Add MCP Server</h2></div>
      <form className="stack-form" onSubmit={handleSubmit}>
        <Field label="server id"><input value={id} onChange={e => setId(e.target.value)} placeholder="my-mcp-server" /></Field>
        <Field label="transport">
          <select value={transport} onChange={e => setTransport(e.target.value as MCPTransport)}>
            {TRANSPORTS.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </Field>
        <Field label="capability adapter">
          <select
            value={adapterKind}
            onChange={e => {
              const value = e.target.value as typeof adapterKind;
              setAdapterKind(value);
              if (value === 'cantool') {
                setTransport('stdio');
                setAuthMode('none');
                setRiskLevel('L0');
              }
            }}
          >
            <option value="generic">generic MCP</option>
            <option value="cantool">CanTool local read-only</option>
          </select>
        </Field>
        <Field label="source URI"><input value={sourceUri} onChange={e => setSourceUri(e.target.value)} placeholder="catalog:team/server@1.0.0" /></Field>
        {transport === 'stdio' ? (
          <>
            <Field label="command"><input value={command} onChange={e => setCommand(e.target.value)} placeholder="npx -y @modelcontextprotocol/server-filesystem" /></Field>
            <Field label="args (comma-separated)"><input value={args} onChange={e => setArgs(e.target.value)} placeholder="/path/to/allowed" /></Field>
          </>
        ) : <Field label="url"><input value={url} onChange={e => setUrl(e.target.value)} placeholder="http://localhost:3001/mcp" /></Field>}
        <div className="two-col">
          <Field label="auth mode">
            <select value={authMode} onChange={e => setAuthMode(e.target.value as typeof authMode)}>
              <option value="none">none</option><option value="credential_ref">credential ref</option><option value="oauth">OAuth ref</option>
            </select>
          </Field>
          <Field label="risk level">
            <select value={riskLevel} onChange={e => setRiskLevel(e.target.value as typeof riskLevel)}>
              <option value="L0">L0</option><option value="L1">L1</option><option value="L2">L2</option>
            </select>
          </Field>
        </div>
        {authMode !== 'none' ? <Field label="credential ref"><input value={credentialRef} onChange={e => setCredentialRef(e.target.value)} placeholder="vault:mcp/server" /></Field> : null}
        <Field label="allowed tools"><input value={allowTools} onChange={e => setAllowTools(e.target.value)} placeholder="search, read" /></Field>
        <Field label="denied tools"><input value={denyTools} onChange={e => setDenyTools(e.target.value)} placeholder="delete, write" /></Field>
        {inspection ? (
          <div className="definition-list">
            <Definition term="version" text={inspection.versionHash.slice(0, 12)} />
            <Definition term="execution" text={inspection.executionSupported ? 'supported' : inspection.blockers.join('; ')} />
            <Definition term="adapter" text={adapterKind === 'cantool' ? 'CanTool reviewed capabilities only' : 'generic MCP tool policy'} />
          </div>
        ) : null}
        {error ? <p className="form-error">{error}</p> : null}
        <div className="inline-actions">
          <button className="ghost-btn" type="button" disabled={!id.trim() || busy} onClick={handleInspect}><Eye size={14} /> inspect</button>
          <button className="primary-btn" type="submit" disabled={!inspection || busy}><Plus size={14} /> apply disabled</button>
        </div>
      </form>
    </>
  );
}
