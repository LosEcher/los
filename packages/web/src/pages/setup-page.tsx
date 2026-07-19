import { useQuery } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, CircleDashed, RefreshCw, Wrench } from 'lucide-react';
import { getJson, type ProviderDiscovery } from '../api/index.js';
import { StatusPill } from '../ui.js';

type SetupState = 'ready' | 'action' | 'optional' | 'unknown';
type SetupPageId = 'providers' | 'nodes' | 'chat' | 'communication-accounts' | 'skills' | 'services';

type SetupCheck = {
  id: string;
  label: string;
  state: SetupState;
  detail: string;
  action?: { label: string; page?: SetupPageId; focusAuth?: boolean };
};

type Settled = PromiseSettledResult<unknown>;

type SetupSnapshot = {
  checks: SetupCheck[];
  actionCount: number;
};

const ENDPOINTS = [
  '/health',
  '/settings',
  '/onboarding',
  '/workspace',
  '/projects',
  '/services',
  '/nodes',
  '/communication/accounts',
] as const;

export function SetupPage() {
  const setup = useQuery({
    queryKey: ['setup-readiness'],
    queryFn: loadSetupSnapshot,
    retry: false,
    refetchInterval: 15_000,
  });
  const checks = setup.data?.checks ?? [];
  const actionCount = setup.data?.actionCount ?? 0;

  return (
    <section className="panel-grid setup-grid">
      <div className="panel">
        <div className="panel-head">
          <div className="title-row">
            <Wrench size={18} />
            <div>
              <h2>Runtime Setup</h2>
              <p>Current readiness across the local execution surfaces.</p>
            </div>
          </div>
          <div className="toolbar">
            <StatusPill status={actionCount === 0 && checks.length > 0 ? 'live' : 'partial'} />
            <button
              type="button"
              className="icon-btn"
              aria-label="Refresh setup status"
              title="Refresh setup status"
              onClick={() => setup.refetch()}
              disabled={setup.isFetching}
            >
              <RefreshCw size={15} />
            </button>
          </div>
        </div>

        {setup.isLoading ? <div className="empty-text">Checking runtime...</div> : null}
        {setup.isError ? (
          <div className="setup-error">
            <AlertCircle size={16} />
            <span>Gateway readiness could not be loaded.</span>
          </div>
        ) : null}
        {checks.length > 0 ? (
          <div className="setup-list">
            {checks.map(check => (
              <div className="setup-row" key={check.id} data-state={check.state}>
                <SetupStateIcon state={check.state} />
                <div className="setup-copy">
                  <strong>{check.label}</strong>
                  <span>{check.detail}</span>
                </div>
                <span className="setup-state">{check.state}</span>
                {check.action ? (
                  <button type="button" className="ghost-btn" onClick={() => runAction(check.action!)}>
                    {check.action.label}
                  </button>
                ) : <span />}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <aside className="panel inspector">
        <div className="panel-head compact"><h2>Readiness</h2></div>
        <div className="fact-list compact-facts">
          <div className="fact"><span>ready</span><strong>{countState(checks, 'ready')}</strong></div>
          <div className="fact"><span>action</span><strong>{countState(checks, 'action')}</strong></div>
          <div className="fact"><span>optional</span><strong>{countState(checks, 'optional')}</strong></div>
          <div className="fact"><span>unknown</span><strong>{countState(checks, 'unknown')}</strong></div>
        </div>
        <div className="setup-boundary-note">
          Provider discovery and compatibility evidence are separate checks.
        </div>
      </aside>
    </section>
  );
}

async function loadSetupSnapshot(): Promise<SetupSnapshot> {
  const settled = await Promise.allSettled(ENDPOINTS.map(path => getJson<unknown>(path)));
  const results = Object.fromEntries(ENDPOINTS.map((path, index) => [path, settled[index]])) as Record<(typeof ENDPOINTS)[number], Settled>;
  const health = valueRecord(results['/health']);
  if (health.status !== 'ok') throw new Error('gateway unavailable');

  const settings = valueRecord(results['/settings']);
  const onboarding = valueRecord(results['/onboarding']) as ProviderDiscovery;
  const projects = valueRecord(results['/projects']);
  const services = valueArray(results['/services']);
  const nodes = valueArray(results['/nodes']);
  const communication = valueRecord(results['/communication/accounts']);
  const protectedReady = ENDPOINTS.slice(3).some(path => results[path].status === 'fulfilled');

  const checks: SetupCheck[] = [
    { id: 'gateway', label: 'Gateway', state: 'ready', detail: 'Health endpoint is responding.' },
    databaseCheck(results['/services'], results['/nodes'], services, nodes),
    authCheck(settings, protectedReady),
    providerCheck(onboarding),
    executorCheck(settings, results['/nodes'], nodes),
    workspaceCheck(results['/projects'], projects),
    channelCheck(results['/communication/accounts'], communication),
    toolingCheck(onboarding),
  ];
  return { checks, actionCount: checks.filter(check => check.state === 'action' || check.state === 'unknown').length };
}

function databaseCheck(servicesResult: Settled, nodesResult: Settled, services: unknown[], nodes: unknown[]): SetupCheck {
  if (servicesResult.status === 'fulfilled' || nodesResult.status === 'fulfilled') {
    return { id: 'database', label: 'Database', state: 'ready', detail: `Registry reads succeeded: ${services.length} services, ${nodes.length} nodes.` };
  }
  return { id: 'database', label: 'Database', state: 'unknown', detail: 'Registry reads are unavailable.', action: { label: 'Open Services', page: 'services' } };
}

function authCheck(settings: Record<string, unknown>, protectedReady: boolean): SetupCheck {
  if (asRecord(settings.auth).enabled !== true) return { id: 'auth', label: 'Auth', state: 'ready', detail: 'Disabled for this local gateway.' };
  if (protectedReady) return { id: 'auth', label: 'Auth', state: 'ready', detail: 'Enabled and the saved credentials are accepted.' };
  return { id: 'auth', label: 'Auth', state: 'action', detail: 'Enabled; protected checks need a valid access token.', action: { label: 'Set tokens', focusAuth: true } };
}

function providerCheck(onboarding: ProviderDiscovery): SetupCheck {
  const providers = arrayRecords(onboarding.providers);
  const ready = providers.filter(providerReady);
  const verified = ready.filter(hasPassingCompatibility);
  if (ready.length === 0) {
    return { id: 'provider', label: 'Provider', state: 'action', detail: 'No execution-ready provider is configured.', action: { label: 'Open Providers', page: 'providers' } };
  }
  if (verified.length === 0) {
    return { id: 'provider', label: 'Provider', state: 'action', detail: `${ready.length} configured; passing compatibility evidence is still required.`, action: { label: 'Review Providers', page: 'providers' } };
  }
  return { id: 'provider', label: 'Provider', state: 'ready', detail: `${ready.length} configured, ${verified.length} with passing compatibility evidence.` };
}

function executorCheck(settings: Record<string, unknown>, result: Settled, nodes: unknown[]): SetupCheck {
  if (asRecord(settings.executor).enabled !== true) return { id: 'executor', label: 'Executor', state: 'optional', detail: 'Disabled; gateway-local execution remains available.', action: { label: 'Open Nodes', page: 'nodes' } };
  if (result.status === 'rejected') return { id: 'executor', label: 'Executor', state: 'unknown', detail: 'Enabled; node registry is unavailable.', action: { label: 'Open Nodes', page: 'nodes' } };
  const candidates = arrayRecords(nodes).filter(node => asRecord(node.execution).candidate === true && ['online', 'ready'].includes(String(node.status)));
  return candidates.length > 0
    ? { id: 'executor', label: 'Executor', state: 'ready', detail: `${candidates.length} execution candidate nodes are online.` }
    : { id: 'executor', label: 'Executor', state: 'action', detail: 'Enabled; no execution candidate node is online.', action: { label: 'Open Nodes', page: 'nodes' } };
}

function workspaceCheck(result: Settled, projects: Record<string, unknown>): SetupCheck {
  if (result.status === 'rejected') return { id: 'workspace', label: 'Workspace', state: 'unknown', detail: 'Project bindings are unavailable.', action: { label: 'Bind Project', page: 'chat' } };
  const count = Array.isArray(projects.projects) ? projects.projects.length : 0;
  return count > 0
    ? { id: 'workspace', label: 'Workspace', state: 'ready', detail: `${count} project bindings are available.` }
    : { id: 'workspace', label: 'Workspace', state: 'action', detail: 'No project is bound.', action: { label: 'Bind Project', page: 'chat' } };
}

function channelCheck(result: Settled, communication: Record<string, unknown>): SetupCheck {
  if (result.status === 'rejected') return { id: 'channel', label: 'Channels', state: 'unknown', detail: 'Channel status is unavailable.', action: { label: 'Open Communications', page: 'communication-accounts' } };
  const channels = arrayRecords(communication.channels);
  const live = channels.filter(channel => channel.live === true).length;
  const connected = channels.filter(channel => channel.status === 'connected').length;
  return {
    id: 'channel', label: 'Channels', state: live > 0 ? 'ready' : 'optional',
    detail: `${live} live channel types, ${connected} external channels connected.`,
    action: { label: 'Open Communications', page: 'communication-accounts' },
  };
}

function toolingCheck(onboarding: ProviderDiscovery): SetupCheck {
  const tools = arrayRecords(onboarding.tools);
  const installed = tools.filter(tool => tool.installed === true).length;
  const hermes = tools.find(tool => String(tool.name ?? '').toLowerCase().includes('hermes'));
  return {
    id: 'tooling', label: 'Tool discovery', state: installed > 0 ? 'ready' : 'optional',
    detail: `${installed} external tools detected; Hermes ${hermes?.installed === true ? 'detected' : 'not detected'}.`,
    action: { label: 'Open Skills', page: 'skills' },
  };
}

function SetupStateIcon({ state }: { state: SetupState }) {
  if (state === 'ready') return <CheckCircle2 className="setup-icon ready" size={18} />;
  if (state === 'action') return <AlertCircle className="setup-icon action" size={18} />;
  return <CircleDashed className={`setup-icon ${state}`} size={18} />;
}

function runAction(action: NonNullable<SetupCheck['action']>) {
  if (action.page) window.location.hash = action.page;
  if (action.focusAuth) {
    const input = document.querySelector<HTMLInputElement>('.auth-banner input');
    input?.focus();
  }
}

function valueRecord(result: Settled): Record<string, unknown> {
  return result.status === 'fulfilled' ? asRecord(result.value) : {};
}

function valueArray(result: Settled): unknown[] {
  return result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function providerReady(provider: Record<string, unknown>): boolean {
  return asRecord(provider.readiness).ready === true || provider.ready === true;
}

function hasPassingCompatibility(provider: Record<string, unknown>): boolean {
  const compat = asRecord(provider.compatEvidence);
  const latest = asRecord(compat.latest);
  if (latest.passed === true || compat.latestVerdict === 'pass' || compat.latestVerdict === 'passed') return true;
  return arrayRecords(provider.compatibilityEvidence).some(item => item.passed === true || item.success === true || item.status === 'passed' || item.verdict === 'pass');
}

function countState(checks: SetupCheck[], state: SetupState): number {
  return checks.filter(check => check.state === state).length;
}
