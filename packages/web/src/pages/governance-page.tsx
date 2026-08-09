/**
 * Governance ops page — view GA jobs / self-bootstrap state and run operator actions.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getJson, postJson } from '../api/index.js';
import { DataTable, EmptyText, StatusPill, Fact, formatDate } from '../ui.js';
import { useI18n } from '../i18n';

interface GovernanceJobSummary {
  id: string;
  jobType: string;
  cadence: string;
  status: string;
  autoFixEnabled: boolean;
  maxAutoFixAttempts: number | null;
  stopCondition: string | null;
  circuitState: string;
  consecutiveNoOps: number;
  consecutiveFailures: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  findingCount: number | null;
  escalated: boolean;
  resultKeys: string[];
  updatedAt: string;
}

interface GovernanceListResponse {
  count: number;
  attentionCount: number;
  jobs: GovernanceJobSummary[];
}

interface GovernanceDetail extends GovernanceJobSummary {
  resultSummary: Record<string, unknown> | null;
  autoFix: {
    autoFixEnabled: boolean;
    maxAutoFixAttempts: number;
    stopCondition: string | null;
  } | null;
  config: Record<string, unknown>;
}

interface SweepResult {
  ok?: boolean;
  dryRun: boolean;
  jobsRun: number;
  jobsSkipped: number;
  findingsCreated: number;
  errorCount: number;
  errors: string[];
}

function circuitTone(state: string): 'ok' | 'warn' | 'err' | 'info' {
  if (state === 'open') return 'err';
  if (state === 'half_open') return 'warn';
  return 'ok';
}

export function GovernancePage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['governance-jobs'],
    queryFn: () => getJson<GovernanceListResponse>('/governance/jobs'),
    refetchInterval: 30_000,
  });

  const detail = useQuery({
    queryKey: ['governance-job', selected],
    queryFn: () => getJson<GovernanceDetail>(`/governance/jobs/${selected}`),
    enabled: Boolean(selected),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['governance-jobs'] });
    if (selected) queryClient.invalidateQueries({ queryKey: ['governance-job', selected] });
  };

  const runJob = useMutation({
    mutationFn: (jobType: string) =>
      postJson<SweepResult>(`/governance/jobs/${jobType}/run`, {}),
    onSuccess: (data, jobType) => {
      setLastAction(t('ops.governance.actionRan', {
        job: jobType,
        findings: String(data.findingsCreated),
        errors: String(data.errorCount),
      }));
      invalidate();
    },
    onError: (err: Error) => setLastAction(err.message),
  });

  const setStatus = useMutation({
    mutationFn: ({ jobType, status }: { jobType: string; status: 'active' | 'paused' }) =>
      postJson(`/governance/jobs/${jobType}/status`, { status }),
    onSuccess: (_data, vars) => {
      setLastAction(t('ops.governance.actionStatus', {
        job: vars.jobType,
        status: vars.status,
      }));
      invalidate();
    },
    onError: (err: Error) => setLastAction(err.message),
  });

  const sweepAll = useMutation({
    mutationFn: (dryRun: boolean) =>
      postJson<SweepResult>(`/governance/jobs/sweep?force=true${dryRun ? '&dryRun=true' : ''}`, {}),
    onSuccess: (data) => {
      setLastAction(t('ops.governance.actionSweep', {
        dry: data.dryRun ? t('ops.governance.dryRun') : t('ops.governance.liveRun'),
        run: String(data.jobsRun),
        findings: String(data.findingsCreated),
        errors: String(data.errorCount),
      }));
      invalidate();
    },
    onError: (err: Error) => setLastAction(err.message),
  });

  const jobs = list.data?.jobs ?? [];
  const attention = useMemo(
    () => jobs.filter(j => j.escalated || j.circuitState === 'open' || j.status === 'paused' || (j.findingCount ?? 0) > 0),
    [jobs],
  );

  return (
    <section className="panel-grid ops-page">
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>{t('ops.governance.title')}</h2>
            <p>{t('ops.governance.subtitle')}</p>
          </div>
          <StatusPill status={attention.length > 0 ? 'live' : 'partial'} />
        </div>

        <div className="fact-list" style={{ marginBottom: 16 }}>
          <Fact label={t('ops.governance.factJobs')} value={String(list.data?.count ?? jobs.length)} />
          <Fact label={t('ops.governance.factAttention')} value={String(list.data?.attentionCount ?? attention.length)} />
          <Fact
            label={t('ops.governance.factAutofix')}
            value={String(jobs.filter(j => j.autoFixEnabled).length)}
          />
        </div>

        <div className="row-actions" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="ghost-btn"
            disabled={sweepAll.isPending}
            onClick={() => sweepAll.mutate(true)}
          >
            {t('ops.governance.sweepDry')}
          </button>
          <button
            type="button"
            className="primary-btn"
            disabled={sweepAll.isPending}
            onClick={() => sweepAll.mutate(false)}
          >
            {t('ops.governance.sweepLive')}
          </button>
        </div>

        {lastAction ? <p className="muted" style={{ marginBottom: 12 }}>{lastAction}</p> : null}

        <DataTable
          loading={list.isLoading}
          empty={t('ops.governance.empty')}
          rows={jobs}
          renderRow={(row) => (
            <div key={row.id} className={`record-row ${row.escalated || row.circuitState === 'open' ? '' : 'record-dim'}`}>
              <div className="record-main">
                <div className="record-header">
                  <button type="button" className="link-btn" onClick={() => setSelected(row.jobType)}>
                    <strong className="record-title"><code>{row.jobType}</code></strong>
                  </button>
                  <span className={`status-pill ${row.status === 'active' ? 'live' : 'partial'}`}>{row.status}</span>
                  {row.escalated ? <span className="status-pill live">{t('ops.governance.escalated')}</span> : null}
                  <span className={`status-pill ${circuitTone(row.circuitState) === 'err' ? 'live' : 'partial'}`}>
                    {row.circuitState}
                  </span>
                </div>
                <div className="record-meta">
                  <span>{row.cadence}</span>
                  <span> · {row.autoFixEnabled ? t('ops.governance.autofixOn') : t('ops.governance.autofixOff')}</span>
                  {row.findingCount != null ? <span> · {t('ops.governance.findingsShort', { n: String(row.findingCount) })}</span> : null}
                  {row.lastRunAt ? <span> · {formatDate(row.lastRunAt)}</span> : null}
                </div>
                <div className="row-actions" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="ghost-btn tiny-btn"
                    disabled={runJob.isPending}
                    onClick={() => runJob.mutate(row.jobType)}
                  >
                    {t('ops.governance.runNow')}
                  </button>
                  {row.status === 'active' ? (
                    <button
                      type="button"
                      className="ghost-btn tiny-btn"
                      disabled={setStatus.isPending}
                      onClick={() => setStatus.mutate({ jobType: row.jobType, status: 'paused' })}
                    >
                      {t('ops.governance.pause')}
                    </button>
                  ) : null}
                  {row.status === 'paused' ? (
                    <button
                      type="button"
                      className="ghost-btn tiny-btn"
                      disabled={setStatus.isPending}
                      onClick={() => setStatus.mutate({ jobType: row.jobType, status: 'active' })}
                    >
                      {t('ops.governance.resume')}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          )}
        />
      </div>

      {selected ? (
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>{t('ops.governance.detailTitle', { job: selected })}</h2>
              <p>{t('ops.governance.detailSubtitle')}</p>
            </div>
            <button type="button" className="ghost-btn tiny-btn" onClick={() => setSelected(null)}>
              {t('ops.governance.closeDetail')}
            </button>
          </div>
          {detail.isLoading ? <EmptyText text={t('ops.governance.loadingDetail')} /> : null}
          {detail.data ? (
            <>
              <div className="fact-list" style={{ marginBottom: 12 }}>
                <Fact label={t('ops.governance.colStatus')} value={detail.data.status} />
                <Fact label={t('ops.governance.colCadence')} value={detail.data.cadence} />
                <Fact label="circuit" value={detail.data.circuitState} />
                <Fact
                  label={t('ops.governance.colFindings')}
                  value={detail.data.findingCount == null ? '—' : String(detail.data.findingCount)}
                />
              </div>
              {detail.data.autoFix?.stopCondition ? (
                <p className="muted">{t('ops.governance.stopCondition')}: {detail.data.autoFix.stopCondition}</p>
              ) : null}
              <pre className="code-block" style={{ maxHeight: 360, overflow: 'auto' }}>
                {JSON.stringify(detail.data.resultSummary ?? {}, null, 2)}
              </pre>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
