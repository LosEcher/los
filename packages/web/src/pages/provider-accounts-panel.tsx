import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Link2,
  RefreshCcw,
  ScanSearch,
  Terminal,
  Unplug,
} from 'lucide-react';
import {
  getJson,
  postJson,
  type ProviderAccountDiscoveryResponse,
  type ProviderAccountsResponse,
} from '../api';
import { formatDate } from '../ui';
import { useI18n } from '../i18n';

export const PROVIDER_ACCOUNTS_QUERY_KEY = ['provider-accounts'] as const;
export const PROVIDER_ACCOUNT_DISCOVERY_QUERY_KEY = ['provider-account-discovery'] as const;

export function ProviderAccountsPanel() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const accounts = useQuery({
    queryKey: PROVIDER_ACCOUNTS_QUERY_KEY,
    queryFn: () => getJson<ProviderAccountsResponse>('/providers/accounts'),
    staleTime: 20_000,
  });
  const discovery = useQuery({
    queryKey: PROVIDER_ACCOUNT_DISCOVERY_QUERY_KEY,
    queryFn: () => getJson<ProviderAccountDiscoveryResponse>('/providers/accounts/discovery'),
    staleTime: 20_000,
  });
  const adopt = useMutation({
    mutationFn: () => postJson<{ account: ProviderAccountsResponse['accounts'][number] }>('/providers/accounts/grok', {}),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: PROVIDER_ACCOUNTS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: PROVIDER_ACCOUNT_DISCOVERY_QUERY_KEY }),
      ]);
    },
  });
  const grok = discovery.data?.grok;
  const adopted = accounts.data?.accounts.find(account => account.id === 'xai-grok-default');
  const active = adopted?.state === 'active';
  const ready = grok?.available === true && active;

  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: PROVIDER_ACCOUNTS_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: PROVIDER_ACCOUNT_DISCOVERY_QUERY_KEY }),
  ]);

  return (
    <section className="provider-account-band" aria-labelledby="provider-accounts-title">
      <div className="provider-account-heading">
        <div>
          <span className="eyebrow">{t('pages.accounts.eyebrow')}</span>
          <h2 id="provider-accounts-title">{t('pages.accounts.title')}</h2>
        </div>
        <button
          type="button"
          className="tiny-btn"
          onClick={() => void refresh()}
          disabled={accounts.isFetching || discovery.isFetching}
          title={t('pages.accounts.scanTitle')}
          aria-label={t('pages.accounts.scanTitle')}
        >
          <RefreshCcw size={14} />
        </button>
      </div>

      <div className="provider-account-row" data-ready={ready}>
        <span className="provider-account-icon" aria-hidden="true">
          {ready ? <CheckCircle2 size={18} /> : grok?.available ? <ScanSearch size={18} /> : <Unplug size={18} />}
        </span>
        <div className="provider-account-primary">
          <strong>{t('pages.accounts.grokCliLogin')}</strong>
          <span>{accountStateLabel({ loading: discovery.isLoading || accounts.isLoading, available: grok?.available, active }, t)}</span>
        </div>
        <div className="provider-account-facts">
          <span><Terminal size={13} /> {sourceLabel(grok?.sourceKind, t)}</span>
          <span>{grok?.authMode ? grok.authMode.toUpperCase() : t('pages.accounts.authUnknown')}</span>
          <span>{adopted?.verifiedAt ? t('pages.accounts.verifiedAt', { date: formatDate(adopted.verifiedAt) }) : t('pages.accounts.notAdopted')}</span>
        </div>
        <div className="provider-account-action">
          {grok?.available && !active ? (
            <button type="button" className="btn" onClick={() => adopt.mutate()} disabled={adopt.isPending}>
              <Link2 size={14} /> {adopt.isPending ? t('pages.accounts.adopting') : t('pages.accounts.useLogin')}
            </button>
          ) : (
            <span className={`status-text ${ready ? 'succeeded' : 'blocked'}`}>{ready ? t('pages.accounts.runtimeReady') : reasonLabel(grok?.reason, t)}</span>
          )}
        </div>
      </div>

      {adopt.isError ? <p className="error-banner" role="alert">{String(adopt.error)}</p> : null}
      <p className="provider-account-note" aria-live="polite">
        {ready
          ? t('pages.accounts.noteReady')
          : t('pages.accounts.noteUnavailable')}
      </p>
    </section>
  );
}

function accountStateLabel(input: { loading: boolean; available?: boolean; active: boolean }, t: (key: string) => string): string {
  if (input.loading) return t('pages.accounts.stateScanning');
  if (input.available && input.active) return t('pages.accounts.stateAdopted');
  if (input.available) return t('pages.accounts.stateAwaiting');
  if (input.active) return t('pages.accounts.stateLoginUnavailable');
  return t('pages.accounts.stateNone');
}

function sourceLabel(source: ProviderAccountDiscoveryResponse['grok']['sourceKind'] | undefined, t: (key: string) => string): string {
  if (source === 'inline_env') return 'GROK_AUTH';
  if (source === 'explicit_path') return t('pages.accounts.sourceConfigured');
  if (source === 'grok_home') return 'GROK_HOME';
  return t('pages.accounts.sourceDefault');
}

function reasonLabel(reason: string | null | undefined, t: (key: string) => string): string {
  if (!reason) return t('pages.accounts.notReady');
  const labels: Record<string, string> = {
    grok_auth_not_found: t('pages.accounts.reasonNotFound'),
    grok_auth_malformed: t('pages.accounts.reasonMalformed'),
    grok_auth_expired: t('pages.accounts.reasonExpired'),
    grok_auth_mode_unsupported: t('pages.accounts.reasonModeUnsupported'),
    grok_auth_missing_credential: t('pages.accounts.reasonMissingCredential'),
    grok_cli_not_found: t('pages.accounts.reasonCliMissing'),
  };
  return labels[reason] ?? t('pages.accounts.notReady');
}
