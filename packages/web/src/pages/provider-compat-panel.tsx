/**
 * One-click provider compatibility run + latest evidence strip.
 * Extracted from providers-page to keep that file under size gates.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, ShieldCheck } from 'lucide-react';
import { getJson, postJson } from '../api';
import { EmptyText, Fact } from '../ui';
import { useI18n } from '../i18n';

type CompatExecuteResponse = {
  ok: boolean;
  evidenceId?: string | null;
  elapsedMs?: number;
  cliEquivalent?: string;
  summary?: {
    passed?: boolean;
    probeId?: string;
    model?: string | null;
    totalTokens?: number;
    toolCalls?: string[];
    failures?: string[];
    error?: string | null;
    sessionId?: string | null;
    taskRunId?: string | null;
  };
  error?: string;
};

type CompatEvidenceRow = {
  id: string;
  provider: string;
  model?: string | null;
  probeId: string;
  decision: string;
  passed: boolean;
  totalTokens: number;
  taskRunId?: string | null;
  runSpecId?: string | null;
  updatedAt?: string;
};

export function ProviderCompatPanel({ providerName, model }: { providerName: string; model?: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [last, setLast] = useState<CompatExecuteResponse | null>(null);

  const evidence = useQuery({
    queryKey: ['provider-compat-evidence', providerName],
    queryFn: () => getJson<{ count: number; evidence: CompatEvidenceRow[] }>(
      `/providers/compat-evidence?provider=${encodeURIComponent(providerName)}&limit=5`,
    ),
    staleTime: 15_000,
  });

  const runCompat = useMutation({
    mutationFn: () => postJson<CompatExecuteResponse>(
      `/providers/${encodeURIComponent(providerName)}/compat/execute`,
      {
        model: model || undefined,
        probe: 'read-context',
      },
    ),
    onSuccess: (body) => {
      setLast(body);
      void qc.invalidateQueries({ queryKey: ['provider-compat-evidence', providerName] });
      void qc.invalidateQueries({ queryKey: ['onboarding'] });
    },
    onError: (error) => {
      setLast({ ok: false, error: error instanceof Error ? error.message : String(error) });
    },
  });

  const rows = evidence.data?.evidence ?? [];

  return (
    <div className="provider-compat-panel">
      <div className="panel-head compact">
        <h3>{t('pages.providers.compatTitle')}</h3>
        <button
          type="button"
          className="tiny-btn primary"
          disabled={runCompat.isPending || !providerName}
          onClick={() => runCompat.mutate()}
          title={t('pages.providers.compatRunTitle')}
        >
          <Play size={12} />
          {runCompat.isPending ? t('pages.providers.compatRunning') : t('pages.providers.compatRun')}
        </button>
      </div>
      <p className="muted-text">{t('pages.providers.compatHint')}</p>

      {last ? (
        <div className={`compat-run-result ${last.ok || last.summary?.passed ? 'is-ok' : 'is-fail'}`}>
          <strong>
            {last.ok || last.summary?.passed
              ? t('pages.providers.compatPassed')
              : t('pages.providers.compatFailed')}
          </strong>
          {last.summary?.probeId ? <span>{last.summary.probeId}</span> : null}
          {last.summary?.totalTokens != null ? <span>{t('pages.providers.compatTokens', { count: last.summary.totalTokens })}</span> : null}
          {last.elapsedMs != null ? <span>{t('pages.providers.compatElapsed', { ms: last.elapsedMs })}</span> : null}
          {last.evidenceId ? <code>{last.evidenceId}</code> : null}
          {last.error ? <span className="error-banner">{last.error}</span> : null}
          {last.summary?.failures && last.summary.failures.length > 0 ? (
            <ul className="compat-failure-list">
              {last.summary.failures.map((failure, index) => (
                <li key={`${failure}-${index}`}>{failure}</li>
              ))}
            </ul>
          ) : null}
          {last.cliEquivalent ? (
            <code className="compat-cli-equivalent">{last.cliEquivalent}</code>
          ) : null}
        </div>
      ) : null}

      <div className="fact-list compact-facts">
        <Fact label={t('pages.providers.compatEvidenceCount')} value={String(rows.length)} />
      </div>

      {evidence.isLoading ? <EmptyText text={t('pages.providers.compatLoading')} /> : null}
      {!evidence.isLoading && rows.length === 0 ? (
        <EmptyText text={t('pages.providers.compatEmpty')} />
      ) : null}
      {rows.length > 0 ? (
        <ul className="compat-evidence-list">
          {rows.map(row => (
            <li key={row.id} className={row.passed ? 'is-pass' : 'is-fail'}>
              <ShieldCheck size={12} />
              <strong>{row.probeId}</strong>
              <span>{row.decision}</span>
              <span>{row.model ?? '—'}</span>
              <code title={row.id}>{row.id.slice(0, 28)}</code>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
