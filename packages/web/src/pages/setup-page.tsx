import { useQuery } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, CircleDashed, RefreshCw, Wrench } from 'lucide-react';
import { getJson, type ProviderDiscovery } from '../api/index.js';
import { StatusPill } from '../ui.js';
import { useI18n } from '../i18n';

type SetupState = 'ready' | 'action' | 'optional' | 'unknown';
type SetupPageId = 'providers' | 'nodes' | 'chat' | 'communication-accounts' | 'skills' | 'services';

type SetupCheck = {
  id: string;
  label: string;
  state: SetupState;
  detail: string;
  detailVars?: Record<string, string | number>;
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
  const { t } = useI18n();
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
              <h2>{t('pages.setup.title')}</h2>
              <p>{t('pages.setup.subtitle')}</p>
            </div>
          </div>
          <div className="toolbar">
            <StatusPill status={actionCount === 0 && checks.length > 0 ? 'live' : 'partial'} />
            <button
              type="button"
              className="icon-btn"
              aria-label={t('pages.setup.refreshAria')}
              title={t('pages.setup.refreshAria')}
              onClick={() => setup.refetch()}
              disabled={setup.isFetching}
            >
              <RefreshCw size={15} />
            </button>
          </div>
        </div>

        {setup.isLoading ? <div className="empty-text">{t('pages.setup.checking')}</div> : null}
        {setup.isError ? (
          <div className="setup-error">
            <AlertCircle size={16} />
            <span>{t('pages.setup.loadError')}</span>
          </div>
        ) : null}
        {checks.length > 0 ? (
          <div className="setup-list">
            {checks.map(check => (
              <div className="setup-row" key={check.id} data-state={check.state}>
                <SetupStateIcon state={check.state} />
                <div className="setup-copy">
                  <strong>{t(check.label)}</strong>
                  <span>{t(check.detail, check.detailVars)}</span>
                </div>
                <span className="setup-state">{t(setupStateKey(check.state))}</span>
                {check.action ? (
                  <button type="button" className="ghost-btn" onClick={() => runAction(check.action!)}>
                    {t(check.action.label)}
                  </button>
                ) : <span />}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <aside className="panel inspector">
        <div className="panel-head compact"><h2>{t('pages.setup.readiness')}</h2></div>
        <div className="fact-list compact-facts">
          <div className="fact"><span>{t('pages.status.ready')}</span><strong>{countState(checks, 'ready')}</strong></div>
          <div className="fact"><span>{t('pages.status.action')}</span><strong>{countState(checks, 'action')}</strong></div>
          <div className="fact"><span>{t('pages.status.optional')}</span><strong>{countState(checks, 'optional')}</strong></div>
          <div className="fact"><span>{t('common.unknown')}</span><strong>{countState(checks, 'unknown')}</strong></div>
        </div>
        <div className="setup-boundary-note">
          {t('pages.setup.boundaryNote')}
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
    { id: 'gateway', label: 'pages.setup.check.gateway', state: 'ready', detail: 'pages.setup.check.gatewayDetail' },
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
    return { id: 'database', label: 'pages.setup.check.database', state: 'ready', detail: 'pages.setup.check.databaseDetail', detailVars: { services: services.length, nodes: nodes.length } };
  }
  return { id: 'database', label: 'pages.setup.check.database', state: 'unknown', detail: 'pages.setup.check.databaseUnavailable', action: { label: 'pages.setup.action.openServices', page: 'services' } };
}

function authCheck(settings: Record<string, unknown>, protectedReady: boolean): SetupCheck {
  if (asRecord(settings.auth).enabled !== true) return { id: 'auth', label: 'pages.setup.check.auth', state: 'ready', detail: 'pages.setup.check.authDisabled' };
  if (protectedReady) return { id: 'auth', label: 'pages.setup.check.auth', state: 'ready', detail: 'pages.setup.check.authEnabled' };
  return { id: 'auth', label: 'pages.setup.check.auth', state: 'action', detail: 'pages.setup.check.authTokenNeeded', action: { label: 'pages.setup.action.setTokens', focusAuth: true } };
}

function providerCheck(onboarding: ProviderDiscovery): SetupCheck {
  const providers = arrayRecords(onboarding.providers);
  const ready = providers.filter(providerReady);
  const verified = ready.filter(hasPassingCompatibility);
  if (ready.length === 0) {
    return { id: 'provider', label: 'pages.setup.check.provider', state: 'action', detail: 'pages.setup.check.providerNone', action: { label: 'pages.setup.action.openProviders', page: 'providers' } };
  }
  if (verified.length === 0) {
    return { id: 'provider', label: 'pages.setup.check.provider', state: 'action', detail: 'pages.setup.check.providerUnverified', detailVars: { count: ready.length }, action: { label: 'pages.setup.action.reviewProviders', page: 'providers' } };
  }
  return { id: 'provider', label: 'pages.setup.check.provider', state: 'ready', detail: 'pages.setup.check.providerReady', detailVars: { count: ready.length, verified: verified.length } };
}

function executorCheck(settings: Record<string, unknown>, result: Settled, nodes: unknown[]): SetupCheck {
  if (asRecord(settings.executor).enabled !== true) return { id: 'executor', label: 'pages.setup.check.executor', state: 'optional', detail: 'pages.setup.check.executorDisabled', action: { label: 'pages.setup.action.openNodes', page: 'nodes' } };
  if (result.status === 'rejected') return { id: 'executor', label: 'pages.setup.check.executor', state: 'unknown', detail: 'pages.setup.check.executorNoRegistry', action: { label: 'pages.setup.action.openNodes', page: 'nodes' } };
  const candidates = arrayRecords(nodes).filter(node => asRecord(node.execution).candidate === true && ['online', 'ready'].includes(String(node.status)));
  return candidates.length > 0
    ? { id: 'executor', label: 'pages.setup.check.executor', state: 'ready', detail: 'pages.setup.check.executorReady', detailVars: { count: candidates.length } }
    : { id: 'executor', label: 'pages.setup.check.executor', state: 'action', detail: 'pages.setup.check.executorNoNodes', action: { label: 'pages.setup.action.openNodes', page: 'nodes' } };
}

function workspaceCheck(result: Settled, projects: Record<string, unknown>): SetupCheck {
  if (result.status === 'rejected') return { id: 'workspace', label: 'pages.setup.check.workspace', state: 'unknown', detail: 'pages.setup.check.workspaceUnavailable', action: { label: 'pages.setup.action.bindProject', page: 'chat' } };
  const count = Array.isArray(projects.projects) ? projects.projects.length : 0;
  return count > 0
    ? { id: 'workspace', label: 'pages.setup.check.workspace', state: 'ready', detail: 'pages.setup.check.workspaceReady', detailVars: { count } }
    : { id: 'workspace', label: 'pages.setup.check.workspace', state: 'action', detail: 'pages.setup.check.workspaceNone', action: { label: 'pages.setup.action.bindProject', page: 'chat' } };
}

function channelCheck(result: Settled, communication: Record<string, unknown>): SetupCheck {
  if (result.status === 'rejected') return { id: 'channel', label: 'pages.setup.check.channels', state: 'unknown', detail: 'pages.setup.check.channelUnavailable', action: { label: 'pages.setup.action.openCommunications', page: 'communication-accounts' } };
  const channels = arrayRecords(communication.channels);
  const live = channels.filter(channel => channel.live === true).length;
  const connected = channels.filter(channel => channel.status === 'connected').length;
  return {
    id: 'channel', label: 'pages.setup.check.channels', state: live > 0 ? 'ready' : 'optional',
    detail: 'pages.setup.check.channelReady',
    detailVars: { live, external: connected },
    action: { label: 'pages.setup.action.openCommunications', page: 'communication-accounts' },
  };
}

function toolingCheck(onboarding: ProviderDiscovery): SetupCheck {
  const tools = arrayRecords(onboarding.tools);
  const installed = tools.filter(tool => tool.installed === true).length;
  const hermes = tools.find(tool => String(tool.name ?? '').toLowerCase().includes('hermes'));
  return {
    id: 'tooling', label: 'pages.setup.check.tooling', state: installed > 0 ? 'ready' : 'optional',
    detail: hermes?.installed === true ? 'pages.setup.check.toolingDetected' : 'pages.setup.check.toolingNotDetected',
    detailVars: { installed },
    action: { label: 'pages.setup.action.openSkills', page: 'skills' },
  };
}

function setupStateKey(state: SetupState): string {
  return state === 'unknown' ? 'common.unknown' : `pages.status.${state}`;
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
