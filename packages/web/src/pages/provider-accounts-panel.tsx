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

export const PROVIDER_ACCOUNTS_QUERY_KEY = ['provider-accounts'] as const;
export const PROVIDER_ACCOUNT_DISCOVERY_QUERY_KEY = ['provider-account-discovery'] as const;

export function ProviderAccountsPanel() {
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
          <span className="eyebrow">credential boundary</span>
          <h2 id="provider-accounts-title">Provider Accounts</h2>
        </div>
        <button
          type="button"
          className="tiny-btn"
          onClick={() => void refresh()}
          disabled={accounts.isFetching || discovery.isFetching}
          title="Scan provider accounts"
          aria-label="Scan provider accounts"
        >
          <RefreshCcw size={14} />
        </button>
      </div>

      <div className="provider-account-row" data-ready={ready}>
        <span className="provider-account-icon" aria-hidden="true">
          {ready ? <CheckCircle2 size={18} /> : grok?.available ? <ScanSearch size={18} /> : <Unplug size={18} />}
        </span>
        <div className="provider-account-primary">
          <strong>Grok CLI login</strong>
          <span>{accountStateLabel({ loading: discovery.isLoading || accounts.isLoading, available: grok?.available, active })}</span>
        </div>
        <div className="provider-account-facts">
          <span><Terminal size={13} /> {sourceLabel(grok?.sourceKind)}</span>
          <span>{grok?.authMode ? grok.authMode.toUpperCase() : 'auth unknown'}</span>
          <span>{adopted?.verifiedAt ? `verified ${formatDate(adopted.verifiedAt)}` : 'not adopted'}</span>
        </div>
        <div className="provider-account-action">
          {grok?.available && !active ? (
            <button type="button" className="btn" onClick={() => adopt.mutate()} disabled={adopt.isPending}>
              <Link2 size={14} /> {adopt.isPending ? 'Adopting...' : 'Use login'}
            </button>
          ) : (
            <span className={`status-text ${ready ? 'succeeded' : 'blocked'}`}>{ready ? 'runtime ready' : reasonLabel(grok?.reason)}</span>
          )}
        </div>
      </div>

      {adopt.isError ? <p className="error-banner" role="alert">{String(adopt.error)}</p> : null}
      <p className="provider-account-note" aria-live="polite">
        {ready
          ? 'Grok owns this login and refreshes it outside LOS.'
          : 'No usable login is copied or stored. Grok runtime remains unavailable until discovery and adoption both pass.'}
      </p>
    </section>
  );
}

function accountStateLabel(input: { loading: boolean; available?: boolean; active: boolean }): string {
  if (input.loading) return 'Scanning local login state';
  if (input.available && input.active) return 'Discovered and adopted';
  if (input.available) return 'Discovered, awaiting adoption';
  if (input.active) return 'Adopted account, login unavailable';
  return 'No usable login discovered';
}

function sourceLabel(source: ProviderAccountDiscoveryResponse['grok']['sourceKind'] | undefined): string {
  if (source === 'inline_env') return 'GROK_AUTH';
  if (source === 'explicit_path') return 'configured store';
  if (source === 'grok_home') return 'GROK_HOME';
  return 'default Grok store';
}

function reasonLabel(reason: string | null | undefined): string {
  if (!reason) return 'not ready';
  const labels: Record<string, string> = {
    grok_auth_not_found: 'login not found',
    grok_auth_malformed: 'login data invalid',
    grok_auth_expired: 'login expired',
    grok_auth_mode_unsupported: 'auth mode unsupported',
    grok_auth_missing_credential: 'credential missing',
    grok_cli_not_found: 'Grok CLI missing',
  };
  return labels[reason] ?? 'not ready';
}
