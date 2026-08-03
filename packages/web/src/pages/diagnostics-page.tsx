import { useQuery } from '@tanstack/react-query';
import { getJson } from '../api/index.js';
import { DataTable, Fact, StatusPill, EmptyText } from '../ui.js';
import { useI18n } from '../i18n';

interface TraceSummary {
  traceId: string;
  sessionId?: string;
  eventCount: number;
  errorCount: number;
  provider?: string;
  model?: string;
  createdAt: string;
}

interface ProviderHealth {
  provider: string;
  totalCalls: number;
  successRate: number;
  avgLatencyMs: number;
  repairCount: number;
  errorBreakdown: Record<string, number>;
}

export function DiagnosticsPage() {
  const { t } = useI18n();
  const traces = useQuery({
    queryKey: ['diagnostics'],
    queryFn: () => getJson<TraceSummary[]>('/diagnostics'),
    refetchInterval: 30_000,
  });

  const providerHealth = useQuery({
    queryKey: ['provider-health'],
    queryFn: () => getJson<ProviderHealth[]>('/diagnostics/provider-health'),
    refetchInterval: 60_000,
  });

  const traceList = traces.data ?? [];
  const healthList = providerHealth.data ?? [];

  return (
    <section className="panel-grid">
      {/* ── Traces ──────────────────────────────────── */}
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>{t('ops.diagnostics.tracesTitle')}</h2>
            <p>{t('ops.diagnostics.tracesSubtitle')}</p>
          </div>
          <StatusPill status={traceList.length > 0 ? 'live' : 'partial'} />
        </div>
        <DataTable
          loading={traces.isLoading}
          empty={t('ops.diagnostics.noTraces')}
          rows={traceList}
          renderRow={(trace) => (
            <div key={trace.traceId} className="record-row">
              <div className="record-main">
                <div className="record-header">
                  <strong className="record-title" style={{ fontFamily: 'monospace', fontSize: 13 }}>
                    {trace.traceId.slice(0, 16)}
                  </strong>
                  {trace.errorCount > 0 ? <span className="status-pill live">{t('ops.diagnostics.errorsLabel', { count: trace.errorCount })}</span> : null}
                </div>
                <div className="record-meta">
                  {trace.sessionId ? <span>{t('ops.diagnostics.sessionShort', { id: trace.sessionId.slice(0, 12) })}</span> : null}
                  {trace.provider ? <span> · {trace.provider}/{trace.model}</span> : null}
                  <span> · {t('ops.diagnostics.eventsLabel', { count: trace.eventCount })}</span>
                  <span> · {new Date(trace.createdAt).toLocaleString()}</span>
                </div>
              </div>
            </div>
          )}
        />
      </div>

      {/* ── Provider Health ───────────────────────────── */}
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>{t('ops.diagnostics.providerHealthTitle')}</h2>
            <p>{t('ops.diagnostics.providerHealthSubtitle')}</p>
          </div>
        </div>
        {healthList.length === 0 ? (
          <EmptyText text={providerHealth.isLoading ? t('common.loading') : t('ops.diagnostics.noProviderHealth')} />
        ) : (
          <table className="project-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>{t('ops.diagnostics.thProvider')}</th>
                <th>{t('ops.diagnostics.thCalls')}</th>
                <th>{t('ops.diagnostics.thSuccessPct')}</th>
                <th>{t('ops.diagnostics.thAvgLatency')}</th>
                <th>{t('ops.diagnostics.thRepairs')}</th>
              </tr>
            </thead>
            <tbody>
              {healthList.map(h => (
                <tr key={h.provider}>
                  <td><strong>{h.provider}</strong></td>
                  <td>{h.totalCalls}</td>
                  <td>
                    <span style={{ color: h.successRate >= 95 ? 'var(--green)' : h.successRate >= 80 ? 'var(--yellow)' : 'var(--red)' }}>
                      {h.successRate.toFixed(1)}%
                    </span>
                  </td>
                  <td>{h.avgLatencyMs.toFixed(0)}ms</td>
                  <td>{h.repairCount > 0 ? <span className="status-pill live">{h.repairCount}</span> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
