import { useQuery } from '@tanstack/react-query';
import { getJson } from '../api/index.js';
import { DataTable, Fact, StatusPill, EmptyText } from '../ui.js';

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
            <h2>Diagnostics · Traces</h2>
            <p>Request traces from the last 24 hours. Errors flagged.</p>
          </div>
          <StatusPill status={traceList.length > 0 ? 'live' : 'partial'} />
        </div>
        <DataTable
          loading={traces.isLoading}
          empty="No recent traces."
          rows={traceList}
          renderRow={(t) => (
            <div key={t.traceId} className="record-row">
              <div className="record-main">
                <div className="record-header">
                  <strong className="record-title" style={{ fontFamily: 'monospace', fontSize: 13 }}>
                    {t.traceId.slice(0, 16)}
                  </strong>
                  {t.errorCount > 0 ? <span className="status-pill live">{t.errorCount} errors</span> : null}
                </div>
                <div className="record-meta">
                  {t.sessionId ? <span>session: {t.sessionId.slice(0, 12)}</span> : null}
                  {t.provider ? <span> · {t.provider}/{t.model}</span> : null}
                  <span> · {t.eventCount} events</span>
                  <span> · {new Date(t.createdAt).toLocaleString()}</span>
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
            <h2>Provider Health</h2>
            <p>Success rate, latency, and repair counters per provider.</p>
          </div>
        </div>
        {healthList.length === 0 ? (
          <EmptyText text={providerHealth.isLoading ? 'Loading...' : 'No provider health data.'} />
        ) : (
          <table className="project-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Calls</th>
                <th>Success %</th>
                <th>Avg Latency</th>
                <th>Repairs</th>
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
