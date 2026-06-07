import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, GitCompare, TrendingDown, TrendingUp } from 'lucide-react';
import { getJson } from './api';
import { DataTable, EmptyText, Fact, formatDate } from './ui';

interface EvalSummaryGroup {
  key: string;
  count: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  averageLatencyMs?: number;
  averageRetryCount: number;
  toolErrorCount: number;
  modelCost: number;
}

interface EvalSummary {
  filters: Record<string, unknown>;
  totals: {
    count: number;
    successCount: number;
    failureCount: number;
    successRate: number;
    averageLatencyMs?: number;
    averageRetryCount: number;
    toolErrorCount: number;
    modelCost: number;
  };
  byFailureClass: EvalSummaryGroup[];
  byFailoverScope: EvalSummaryGroup[];
  byVerificationStatus: EvalSummaryGroup[];
  byProviderModel: EvalSummaryGroup[];
}

interface EvalComparison {
  filters: Record<string, unknown>;
  baseline: EvalSummary;
  candidate: EvalSummary;
  delta: {
    count: number;
    successCount: number;
    failureCount: number;
    successRate: number;
    averageLatencyMs?: number;
    averageRetryCount: number;
    toolErrorCount: number;
    modelCost: number;
  };
}

type ViewMode = 'summary' | 'compare';

export function EvalsPage() {
  const [mode, setMode] = useState<ViewMode>('summary');
  const [runSpecId, setRunSpecId] = useState('');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [baselineFrom, setBaselineFrom] = useState('');
  const [baselineTo, setBaselineTo] = useState('');
  const [candidateFrom, setCandidateFrom] = useState('');
  const [candidateTo, setCandidateTo] = useState('');

  const sharedParams = new URLSearchParams();
  if (runSpecId.trim()) sharedParams.set('runSpecId', runSpecId.trim());
  if (provider.trim()) sharedParams.set('provider', provider.trim());
  if (model.trim()) sharedParams.set('model', model.trim());

  const summary = useQuery({
    queryKey: ['evals-summary', runSpecId, provider, model],
    queryFn: () => getJson<EvalSummary>(`/run-evals/summary?${sharedParams.toString()}`),
    enabled: mode === 'summary',
    refetchInterval: 30_000,
  });

  const compare = useQuery({
    queryKey: ['evals-compare', runSpecId, provider, model, baselineFrom, baselineTo, candidateFrom, candidateTo],
    queryFn: () => {
      const params = new URLSearchParams(sharedParams);
      if (baselineFrom) params.set('baselineFrom', baselineFrom);
      if (baselineTo) params.set('baselineTo', baselineTo);
      if (candidateFrom) params.set('candidateFrom', candidateFrom);
      if (candidateTo) params.set('candidateTo', candidateTo);
      return getJson<EvalComparison>(`/run-evals/compare?${params.toString()}`);
    },
    enabled: mode === 'compare' && Boolean(baselineFrom) && Boolean(baselineTo) && Boolean(candidateFrom) && Boolean(candidateTo),
  });

  return (
    <section className="page-evals">
      <div className="page-toolbar">
        <div className="toolbar-tabs">
          <button
            type="button"
            className={`toolbar-tab ${mode === 'summary' ? 'active' : ''}`}
            onClick={() => setMode('summary')}
          >
            <BarChart3 size={14} /> Summary
          </button>
          <button
            type="button"
            className={`toolbar-tab ${mode === 'compare' ? 'active' : ''}`}
            onClick={() => setMode('compare')}
          >
            <GitCompare size={14} /> Compare
          </button>
        </div>

        <div className="toolbar-filters">
          <input
            className="filter-input"
            placeholder="Run spec ID..."
            value={runSpecId}
            onChange={e => setRunSpecId(e.target.value)}
          />
          <input
            className="filter-input"
            placeholder="Provider..."
            value={provider}
            onChange={e => setProvider(e.target.value)}
          />
          <input
            className="filter-input"
            placeholder="Model..."
            value={model}
            onChange={e => setModel(e.target.value)}
          />
        </div>
      </div>

      {mode === 'summary' && <EvalSummaryView data={summary.data} loading={summary.isLoading} />}
      {mode === 'compare' && (
        <EvalCompareView
          data={compare.data}
          loading={compare.isLoading}
          baselineFrom={baselineFrom}
          baselineTo={baselineTo}
          candidateFrom={candidateFrom}
          candidateTo={candidateTo}
          onBaselineFromChange={setBaselineFrom}
          onBaselineToChange={setBaselineTo}
          onCandidateFromChange={setCandidateFrom}
          onCandidateToChange={setCandidateTo}
        />
      )}
    </section>
  );
}

function EvalSummaryView({ data, loading }: { data?: EvalSummary; loading: boolean }) {
  if (loading) return <div className="loading-block">Loading eval summary...</div>;
  if (!data) return <EmptyText text="No eval data available. Record evals via POST /run-evals or 'los evals record'." />;

  const t = data.totals;
  return (
    <div className="eval-dashboard">
      <div className="metric-cards">
        <MetricCard label="Total Evals" value={String(t.count)} />
        <MetricCard label="Success Rate" value={fmtPct(t.successRate)} tone={t.successRate >= 0.8 ? 'ok' : t.successRate >= 0.5 ? 'warn' : 'err'} />
        <MetricCard label="Failures" value={String(t.failureCount)} tone={t.failureCount > 0 ? 'warn' : 'ok'} />
        <MetricCard label="Avg Latency" value={t.averageLatencyMs !== undefined ? `${Math.round(t.averageLatencyMs)}ms` : 'n/a'} />
        <MetricCard label="Avg Retries" value={t.averageRetryCount.toFixed(1)} />
        <MetricCard label="Tool Errors" value={String(t.toolErrorCount)} tone={t.toolErrorCount > 0 ? 'warn' : 'ok'} />
        <MetricCard label="Model Cost" value={`$${t.modelCost.toFixed(4)}`} />
      </div>

      <div className="summary-groups">
        <GroupTable title="By Failure Class" groups={data.byFailureClass} />
        <GroupTable title="By Failover Scope" groups={data.byFailoverScope} />
        <GroupTable title="By Verification Status" groups={data.byVerificationStatus} />
        <GroupTable title="By Provider / Model" groups={data.byProviderModel} />
      </div>
    </div>
  );
}

function EvalCompareView({
  data, loading,
  baselineFrom, baselineTo, candidateFrom, candidateTo,
  onBaselineFromChange, onBaselineToChange, onCandidateFromChange, onCandidateToChange,
}: {
  data?: EvalComparison; loading: boolean;
  baselineFrom: string; baselineTo: string; candidateFrom: string; candidateTo: string;
  onBaselineFromChange: (v: string) => void; onBaselineToChange: (v: string) => void;
  onCandidateFromChange: (v: string) => void; onCandidateToChange: (v: string) => void;
}) {
  return (
    <div>
      <div className="compare-windows">
        <div className="compare-window">
          <h4>Baseline</h4>
          <label>From <input type="datetime-local" value={toLocal(baselineFrom)} onChange={e => onBaselineFromChange(toIso(e.target.value))} /></label>
          <label>To <input type="datetime-local" value={toLocal(baselineTo)} onChange={e => onBaselineToChange(toIso(e.target.value))} /></label>
        </div>
        <div className="compare-window">
          <h4>Candidate</h4>
          <label>From <input type="datetime-local" value={toLocal(candidateFrom)} onChange={e => onCandidateFromChange(toIso(e.target.value))} /></label>
          <label>To <input type="datetime-local" value={toLocal(candidateTo)} onChange={e => onCandidateToChange(toIso(e.target.value))} /></label>
        </div>
      </div>

      {loading ? (
        <div className="loading-block">Comparing evals...</div>
      ) : !data ? (
        <EmptyText text="Set baseline and candidate time windows to compare eval quality." />
      ) : (
        <div className="eval-dashboard">
          <div className="metric-cards">
            <DeltaCard label="Success Rate" base={data.baseline.totals.successRate} cand={data.candidate.totals.successRate} delta={data.delta.successRate} pct />
            <DeltaCard label="Failures" base={data.baseline.totals.failureCount} cand={data.candidate.totals.failureCount} delta={data.delta.failureCount} />
            <DeltaCard label="Avg Latency" base={data.baseline.totals.averageLatencyMs} cand={data.candidate.totals.averageLatencyMs} delta={data.delta.averageLatencyMs} ms />
            <DeltaCard label="Tool Errors" base={data.baseline.totals.toolErrorCount} cand={data.candidate.totals.toolErrorCount} delta={data.delta.toolErrorCount} />
            <DeltaCard label="Avg Retries" base={data.baseline.totals.averageRetryCount} cand={data.candidate.totals.averageRetryCount} delta={data.delta.averageRetryCount} fixed />
            <DeltaCard label="Model Cost" base={data.baseline.totals.modelCost} cand={data.candidate.totals.modelCost} delta={data.delta.modelCost} cost />
          </div>
        </div>
      )}
    </div>
  );
}

function GroupTable({ title, groups }: { title: string; groups: EvalSummaryGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <div className="group-table-block">
      <h4>{title}</h4>
      <DataTable
        loading={false}
        empty={`No ${title.toLowerCase()} data`}
        rows={groups}
        renderRow={(g) => (
          <tr key={g.key}>
            <td className="cell-key">{g.key}</td>
            <td className="cell-num">{g.count}</td>
            <td className="cell-num">{fmtPct(g.successRate)}</td>
            <td className="cell-num">{g.failureCount}</td>
            <td className="cell-num">{g.averageLatencyMs !== undefined ? `${Math.round(g.averageLatencyMs)}ms` : 'n/a'}</td>
            <td className="cell-num">{g.averageRetryCount.toFixed(1)}</td>
            <td className="cell-num">{g.toolErrorCount}</td>
          </tr>
        )}
      />
    </div>
  );
}

function MetricCard({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'err' }) {
  return (
    <div className={`metric-card ${tone ?? ''}`}>
      <div className="metric-card-label">{label}</div>
      <div className="metric-card-value">{value}</div>
    </div>
  );
}

function DeltaCard({ label, base, cand, delta, pct, ms, fixed, cost }: {
  label: string;
  base: number | undefined;
  cand: number | undefined;
  delta: number | undefined;
  pct?: boolean;
  ms?: boolean;
  fixed?: boolean;
  cost?: boolean;
}) {
  const fmt = (v: number | undefined): string => {
    if (v === undefined || v === null) return 'n/a';
    if (pct) return fmtPct(v);
    if (ms) return `${Math.round(v)}ms`;
    if (cost) return `$${v.toFixed(4)}`;
    if (fixed) return v.toFixed(1);
    return String(typeof v === 'number' ? Math.round(v) : v);
  };
  const baseFmt = fmt(base);
  const candFmt = fmt(cand);
  const deltaVal = delta ?? 0;
  const improved = pct ? deltaVal > 0 : (ms || cost ? deltaVal < 0 : deltaVal < 0);
  const worsened = pct ? deltaVal < 0 : (ms || cost ? deltaVal > 0 : deltaVal > 0);

  return (
    <div className={`metric-card ${improved ? 'ok' : ''} ${worsened ? 'err' : ''}`}>
      <div className="metric-card-label">{label}</div>
      <div className="metric-card-value">
        <span className="delta-from">{baseFmt}</span>
        <span className="delta-arrow">{improved ? <TrendingUp size={12} /> : worsened ? <TrendingDown size={12} /> : '→'}</span>
        <span className="delta-to">{candFmt}</span>
      </div>
      <div className="metric-card-delta">
        Δ {fmtSignedDelta(deltaVal, pct, ms, cost, fixed)}
      </div>
    </div>
  );
}

function fmtPct(v: number): string { return `${(v * 100).toFixed(1)}%`; }

function fmtSignedDelta(v: number, pct?: boolean, ms?: boolean, _cost?: boolean, fixed?: boolean): string {
  const sign = v > 0 ? '+' : '';
  if (pct) return `${sign}${(v * 100).toFixed(1)}pp`;
  if (ms) return `${sign}${Math.round(v)}ms`;
  if (fixed) return `${sign}${v.toFixed(1)}`;
  return `${sign}${Math.round(v)}`;
}

function toLocal(iso: string): string {
  if (!iso) return '';
  try { return new Date(iso).toISOString().slice(0, 16); } catch { return iso.slice(0, 16); }
}

function toIso(local: string): string {
  if (!local) return '';
  return new Date(local).toISOString();
}
