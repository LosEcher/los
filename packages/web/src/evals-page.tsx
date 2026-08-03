import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, CalendarDays, GitCompare, TrendingDown, TrendingUp, Zap, Plus } from 'lucide-react';
import { getJson, postJson } from './api';
import { DailyQualityView } from './pages/daily-quality-view.js';
import { Button, DataTable, EmptyText, Field } from './ui';
import { useI18n } from './i18n';

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

type ViewMode = 'summary' | 'compare' | 'daily';

export function EvalsPage() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [mode, setMode] = useState<ViewMode>('summary');
  const [runSpecId, setRunSpecId] = useState('');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [baselineFrom, setBaselineFrom] = useState('');
  const [baselineTo, setBaselineTo] = useState('');
  const [candidateFrom, setCandidateFrom] = useState('');
  const [candidateTo, setCandidateTo] = useState('');

  // ── Backlog snapshot action ─────────────────────────
  const backlogSnapshot = useMutation({
    mutationFn: () => postJson<{ ok: boolean }>('/eval-backlog/run', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['evals-summary'] }),
  });

  // ── Manual eval record form state ──────────────────
  const [showRecordForm, setShowRecordForm] = useState(false);
  const [recordProvider, setRecordProvider] = useState('');
  const [recordModel, setRecordModel] = useState('');
  const [recordSuccess, setRecordSuccess] = useState(true);
  const [recordLatencyMs, setRecordLatencyMs] = useState('');
  const [recordRunSpecId, setRecordRunSpecId] = useState('');
  const recordEval = useMutation({
    mutationFn: () => postJson('/run-evals', {
      provider: recordProvider.trim() || undefined,
      model: recordModel.trim() || undefined,
      success: recordSuccess,
      latencyMs: recordLatencyMs.trim() ? Number(recordLatencyMs) : undefined,
      runSpecId: recordRunSpecId.trim() || 'manual',
    }),
    onSuccess: () => {
      setShowRecordForm(false);
      setRecordProvider(''); setRecordModel(''); setRecordSuccess(true);
      setRecordLatencyMs(''); setRecordRunSpecId('');
      qc.invalidateQueries({ queryKey: ['evals-summary'] });
    },
  });

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
            <BarChart3 size={14} /> {t('ops.evals.tabSummary')}
          </button>
          <button
            type="button"
            className={`toolbar-tab ${mode === 'compare' ? 'active' : ''}`}
            onClick={() => setMode('compare')}
          >
            <GitCompare size={14} /> {t('ops.evals.tabCompare')}
          </button>
          <button
            type="button"
            className={`toolbar-tab ${mode === 'daily' ? 'active' : ''}`}
            onClick={() => setMode('daily')}
          >
            <CalendarDays size={14} /> {t('ops.evals.tabDailyQuality')}
          </button>
        </div>

        {mode !== 'daily' ? <div className="toolbar-filters">
          <input
            className="filter-input"
            placeholder={t('ops.evals.runSpecFilterPlaceholder')}
            value={runSpecId}
            onChange={e => setRunSpecId(e.target.value)}
          />
          <input
            className="filter-input"
            placeholder={t('ops.evals.providerFilterPlaceholder')}
            value={provider}
            onChange={e => setProvider(e.target.value)}
          />
          <input
            className="filter-input"
            placeholder={t('ops.evals.modelFilterPlaceholder')}
            value={model}
            onChange={e => setModel(e.target.value)}
          />
        </div> : null}

        {mode !== 'daily' ? <div className="toolbar-actions">
          <Button variant="ghost" onClick={() => backlogSnapshot.mutate()} title={t('ops.evals.backlogTitle')}>
            <Zap size={14} /> {backlogSnapshot.isPending ? t('ops.evals.recording') : t('ops.evals.recordBacklogButton')}
          </Button>
          <Button variant="ghost" onClick={() => setShowRecordForm(v => !v)} title={t('ops.evals.recordEvalTitle')}>
            <Plus size={14} /> {t('ops.evals.recordEvalButton')}
          </Button>
        </div> : null}
      </div>

      {showRecordForm && mode !== 'daily' ? (
        <div className="provider-edit-panel">
          <div className="provider-edit-grid">
            <Field label={t('ops.evals.formProvider')}><input value={recordProvider} onChange={e => setRecordProvider(e.target.value)} placeholder={t('ops.evals.providerPlaceholder')} /></Field>
            <Field label={t('ops.evals.formModel')}><input value={recordModel} onChange={e => setRecordModel(e.target.value)} placeholder={t('ops.evals.modelPlaceholder')} /></Field>
            <Field label={t('ops.evals.formRunSpecId')}><input value={recordRunSpecId} onChange={e => setRecordRunSpecId(e.target.value)} placeholder={t('ops.evals.manualPlaceholder')} /></Field>
            <Field label={t('ops.evals.formLatencyMs')}><input type="number" value={recordLatencyMs} onChange={e => setRecordLatencyMs(e.target.value)} placeholder={t('ops.evals.latencyPlaceholder')} /></Field>
          </div>
          <div className="provider-edit-meta">
            <label className="toolbar-toggle">
              <input type="checkbox" checked={recordSuccess} onChange={e => setRecordSuccess(e.target.checked)} />
              {t('ops.evals.successLabel')}
            </label>
            <Button onClick={() => recordEval.mutate()} disabled={recordEval.isPending}>
              {recordEval.isPending ? t('ops.evals.recording') : t('ops.evals.submitButton')}
            </Button>
            <Button variant="ghost" onClick={() => setShowRecordForm(false)}>{t('common.cancel')}</Button>
          </div>
          {recordEval.error ? <div className="error-banner">{String(recordEval.error)}</div> : null}
        </div>
      ) : null}

      {mode === 'summary' && <EvalSummaryView data={summary.data} loading={summary.isLoading} />}
      {mode === 'daily' && <DailyQualityView />}
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
  const { t } = useI18n();
  if (loading) return <div className="loading-block">{t('ops.evals.loadingSummary')}</div>;
  if (!data) return <EmptyText text={t('ops.evals.noData')} />;

  const totals = data.totals;
  return (
    <div className="eval-dashboard">
      <div className="metric-cards">
        <MetricCard label={t('ops.evals.metricTotal')} value={String(totals.count)} />
        <MetricCard label={t('ops.evals.metricSuccessRate')} value={fmtPct(totals.successRate)} tone={totals.successRate >= 0.8 ? 'ok' : totals.successRate >= 0.5 ? 'warn' : 'err'} />
        <MetricCard label={t('ops.evals.metricFailures')} value={String(totals.failureCount)} tone={totals.failureCount > 0 ? 'warn' : 'ok'} />
        <MetricCard label={t('ops.evals.metricAvgLatency')} value={totals.averageLatencyMs !== undefined ? `${Math.round(totals.averageLatencyMs)}ms` : t('ops.na')} />
        <MetricCard label={t('ops.evals.metricAvgRetries')} value={totals.averageRetryCount.toFixed(1)} />
        <MetricCard label={t('ops.evals.metricToolErrors')} value={String(totals.toolErrorCount)} tone={totals.toolErrorCount > 0 ? 'warn' : 'ok'} />
        <MetricCard label={t('ops.evals.metricModelCost')} value={`$${totals.modelCost.toFixed(4)}`} />
      </div>

      <div className="summary-groups">
        <GroupTable title={t('ops.evals.groupFailureClass')} groups={data.byFailureClass} />
        <GroupTable title={t('ops.evals.groupFailoverScope')} groups={data.byFailoverScope} />
        <GroupTable title={t('ops.evals.groupVerificationStatus')} groups={data.byVerificationStatus} />
        <GroupTable title={t('ops.evals.groupProviderModel')} groups={data.byProviderModel} />
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
  const { t } = useI18n();
  return (
    <div>
      <div className="compare-windows">
        <div className="compare-window">
          <h4>{t('ops.evals.baselineTitle')}</h4>
          <label>{t('ops.evals.fromLabel')} <input type="datetime-local" value={toLocal(baselineFrom)} onChange={e => onBaselineFromChange(toIso(e.target.value))} /></label>
          <label>{t('ops.evals.toLabel')} <input type="datetime-local" value={toLocal(baselineTo)} onChange={e => onBaselineToChange(toIso(e.target.value))} /></label>
        </div>
        <div className="compare-window">
          <h4>{t('ops.evals.candidateTitle')}</h4>
          <label>{t('ops.evals.fromLabel')} <input type="datetime-local" value={toLocal(candidateFrom)} onChange={e => onCandidateFromChange(toIso(e.target.value))} /></label>
          <label>{t('ops.evals.toLabel')} <input type="datetime-local" value={toLocal(candidateTo)} onChange={e => onCandidateToChange(toIso(e.target.value))} /></label>
        </div>
      </div>

      {loading ? (
        <div className="loading-block">{t('ops.evals.comparing')}</div>
      ) : !data ? (
        <EmptyText text={t('ops.evals.comparePrompt')} />
      ) : (
        <div className="eval-dashboard">
          <div className="metric-cards">
            <DeltaCard label={t('ops.evals.metricSuccessRate')} base={data.baseline.totals.successRate} cand={data.candidate.totals.successRate} delta={data.delta.successRate} pct />
            <DeltaCard label={t('ops.evals.metricFailures')} base={data.baseline.totals.failureCount} cand={data.candidate.totals.failureCount} delta={data.delta.failureCount} />
            <DeltaCard label={t('ops.evals.metricAvgLatency')} base={data.baseline.totals.averageLatencyMs} cand={data.candidate.totals.averageLatencyMs} delta={data.delta.averageLatencyMs} ms />
            <DeltaCard label={t('ops.evals.metricToolErrors')} base={data.baseline.totals.toolErrorCount} cand={data.candidate.totals.toolErrorCount} delta={data.delta.toolErrorCount} />
            <DeltaCard label={t('ops.evals.metricAvgRetries')} base={data.baseline.totals.averageRetryCount} cand={data.candidate.totals.averageRetryCount} delta={data.delta.averageRetryCount} fixed />
            <DeltaCard label={t('ops.evals.metricModelCost')} base={data.baseline.totals.modelCost} cand={data.candidate.totals.modelCost} delta={data.delta.modelCost} cost />
          </div>
        </div>
      )}
    </div>
  );
}

function GroupTable({ title, groups }: { title: string; groups: EvalSummaryGroup[] }) {
  const { t } = useI18n();
  if (groups.length === 0) return null;
  return (
    <div className="group-table-block">
      <h4>{title}</h4>
      <DataTable
        loading={false}
        empty={t('ops.evals.groupEmpty', { name: title.toLowerCase() })}
        rows={groups}
        renderRow={(g) => (
          <tr key={g.key}>
            <td className="cell-key">{g.key}</td>
            <td className="cell-num">{g.count}</td>
            <td className="cell-num">{fmtPct(g.successRate)}</td>
            <td className="cell-num">{g.failureCount}</td>
            <td className="cell-num">{g.averageLatencyMs !== undefined ? `${Math.round(g.averageLatencyMs)}ms` : t('ops.na')}</td>
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
  const { t } = useI18n();
  const fmt = (v: number | undefined): string => {
    if (v === undefined || v === null) return t('ops.na');
    if (pct) return fmtPct(v);
    if (ms) return `${Math.round(v)}ms`;
    if (cost) return `$${v.toFixed(4)}`;
    if (fixed) return v.toFixed(1);
    return String(typeof v === 'number' ? Math.round(v) : v);
  };
  const baseFmt = fmt(base);
  const candFmt = fmt(cand);
  if (delta === undefined || delta === null) {
    return (
      <div className="metric-card">
        <div className="metric-card-label">{label}</div>
        <div className="metric-card-value">
          <span className="delta-from">{baseFmt}</span>
          <span>→</span>
          <span className="delta-to">{candFmt}</span>
        </div>
        <div className="metric-card-delta">{t('ops.evals.deltaNa')}</div>
      </div>
    );
  }
  const deltaVal = delta;
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
