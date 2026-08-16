import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, X, Play, ShieldCheck } from 'lucide-react';
import { getJson, postJson } from '../api/index.js';
import { Button, DataTable, Fact, StatusPill, EmptyText } from '../ui.js';
import { useI18n } from '../i18n';
import { TopologyPanel } from './topology-panel.js';

/** Matches gateway POST /runs/:id/approve|recover|verify actor field. */
const WEB_OPERATOR_ACTOR = 'web-console';

interface RunSpec {
  id: string;
  sessionId?: string;
  traceId?: string;
  status: string;
  prompt?: string;
  provider?: string;
  model?: string;
  createdAt: string;
  updatedAt?: string;
}

interface RunStateProjection {
  phase?: string;
  action?: string;
  blockers?: Array<{ kind: string; message: string; ids?: string[] }>;
  taskCount?: number;
  verificationCount?: number;
  verifierStatus?: string;
  approvalStatus?: string;
}

/** Backend contract for operator actions (actor + reason, not approved/note). */
export function buildRunOperatorPayload(reason: string | undefined, fallbackReason: string): {
  actor: string;
  reason: string;
} {
  const trimmed = reason?.trim();
  return {
    actor: WEB_OPERATOR_ACTOR,
    reason: trimmed && trimmed.length > 0 ? trimmed : fallbackReason,
  };
}

export function RunSpecsPage({ selectedRunSpecId }: { selectedRunSpecId?: string | null }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [approvalReason, setApprovalReason] = useState('');
  const [showApproval, setShowApproval] = useState(false);

  useEffect(() => {
    if (selectedRunSpecId) setSelectedId(selectedRunSpecId);
  }, [selectedRunSpecId]);

  const runs = useQuery({
    queryKey: ['runs'],
    queryFn: () => getJson<RunSpec[]>('/runs?limit=100'),
    refetchInterval: 30_000,
  });

  const runState = useQuery({
    queryKey: ['run-state', selectedId],
    queryFn: () => getJson<RunStateProjection>(`/runs/${selectedId}/state`),
    enabled: Boolean(selectedId),
  });

  const invalidateRun = () => {
    qc.invalidateQueries({ queryKey: ['runs'] });
    qc.invalidateQueries({ queryKey: ['run-state', selectedId] });
  };

  const closeApprovalForm = () => {
    setShowApproval(false);
    setApprovalReason('');
  };

  // Approve plan phase — POST /runs/:id/approve expects { actor, reason }
  const approveRun = useMutation({
    mutationFn: (id: string) =>
      postJson(`/runs/${id}/approve`, buildRunOperatorPayload(approvalReason, 'operator approved plan')),
    onSuccess: () => {
      invalidateRun();
      closeApprovalForm();
    },
  });

  // Reject/cancel run — no approve(false) API; recover with intent=cancel
  const rejectRun = useMutation({
    mutationFn: (id: string) =>
      postJson(`/runs/${id}/recover`, {
        ...buildRunOperatorPayload(approvalReason, 'operator rejected run'),
        apply: true,
        intent: 'cancel',
      }),
    onSuccess: () => {
      invalidateRun();
      closeApprovalForm();
    },
  });

  const verifyRun = useMutation({
    mutationFn: (id: string) => postJson(`/runs/${id}/verify`, {}),
    onSuccess: () => {
      invalidateRun();
    },
  });

  const runList = runs.data ?? [];
  const busy = approveRun.isPending || rejectRun.isPending || verifyRun.isPending;

  return (
    <section className="panel-grid ops-page">
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>{t('ops.runSpecs.title')}</h2>
            <p>{t('ops.runSpecs.subtitle')}</p>
          </div>
          <StatusPill status={runList.length > 0 ? 'live' : 'partial'} />
        </div>
        <DataTable
          loading={runs.isLoading}
          empty={t('ops.runSpecs.empty')}
          rows={runList}
          renderRow={(r) => (
            <div
              key={r.id}
              className={`record-row record-row-stack ${selectedId === r.id ? 'record-selected' : ''}`}
              data-active={selectedId === r.id}
              onClick={() => setSelectedId(selectedId === r.id ? null : r.id)}
            >
              <div className="record-main">
                <div className="record-header">
                  <strong className="record-title">{r.id.slice(0, 16)}</strong>
                  <span className={`status-text ${r.status}`}>{r.status}</span>
                </div>
                <div className="record-meta">
                  {r.provider ? <span>{r.provider}/{r.model}</span> : null}
                  {r.sessionId ? <span>{t('ops.runSpecs.sessionShort', { sessionId: r.sessionId.slice(0, 12) })}</span> : null}
                  <span>{new Date(r.createdAt).toLocaleString()}</span>
                </div>
                {r.prompt ? (
                  <div className="record-detail">
                    {r.prompt.length > 200 ? r.prompt.slice(0, 200) + '...' : r.prompt}
                  </div>
                ) : null}
              </div>
            </div>
          )}
        />
      </div>

      <aside className="panel inspector">
        <div className="panel-head compact"><h2>{t('ops.runSpecs.runStateTitle')}</h2></div>
        {!selectedId ? (
          <EmptyText text={t('ops.runSpecs.selectPrompt')} />
        ) : runState.isLoading ? (
          <EmptyText text={t('common.loading')} />
        ) : runState.data ? (
          <>
            <div className="fact-list">
              <Fact label={t('ops.runSpecs.factPhase')} value={runState.data.phase ?? '—'} />
              <Fact label={t('ops.runSpecs.factAction')} value={runState.data.action ?? '—'} />
              <Fact label={t('ops.runSpecs.factTasks')} value={String(runState.data.taskCount ?? 0)} />
              <Fact label={t('ops.runSpecs.factVerifications')} value={String(runState.data.verificationCount ?? 0)} />
              <Fact label={t('ops.runSpecs.factVerifier')} value={runState.data.verifierStatus ?? '—'} />
              {runState.data.approvalStatus ? (
                <Fact label={t('ops.runSpecs.factApproval')} value={runState.data.approvalStatus} />
              ) : null}
              {runState.data.blockers && runState.data.blockers.length > 0 ? (
                <div className="blocker-list">
                  <strong style={{ fontSize: 13 }}>{t('ops.runSpecs.blockersTitle')}</strong>
                  <ul style={{ margin: '4px 0 0 16px', fontSize: 13, color: 'var(--text-dim)' }}>
                    {(runState.data.blockers ?? []).map((b, i) => (
                      <li key={i}>{b.message}{b.ids && b.ids.length > 0 ? ` (${b.ids.join(', ')})` : ''}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>

            <div className="section-divider" />
            <div className="panel-head compact"><h2>{t('ops.runSpecs.operatorActionsTitle')}</h2></div>
            <div style={{ padding: '8px 16px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {!showApproval ? (
                  <Button variant="ghost" onClick={() => setShowApproval(true)} disabled={busy}>
                    <Play size={14} /> {t('ops.runSpecs.approveRejectButton')}
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  onClick={() => verifyRun.mutate(selectedId!)}
                  disabled={busy}
                >
                  <ShieldCheck size={14} /> {verifyRun.isPending ? t('ops.runSpecs.verifying') : t('ops.runSpecs.verifyButton')}
                </Button>
              </div>

              {showApproval ? (
                <div className="approval-panel">
                  <textarea
                    rows={2}
                    placeholder={t('ops.runSpecs.reasonPlaceholder')}
                    value={approvalReason}
                    onChange={e => setApprovalReason(e.target.value)}
                    style={{ width: '100%', marginBottom: 8 }}
                  />
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Button onClick={() => approveRun.mutate(selectedId!)} disabled={busy}>
                      <Check size={14} /> {approveRun.isPending ? t('ops.runSpecs.approving') : t('ops.runSpecs.approvePlanButton')}
                    </Button>
                    <Button variant="danger" onClick={() => rejectRun.mutate(selectedId!)} disabled={busy}>
                      <X size={14} /> {rejectRun.isPending ? t('ops.runSpecs.rejecting') : t('ops.runSpecs.rejectCancelButton')}
                    </Button>
                    <Button variant="ghost" onClick={closeApprovalForm} disabled={busy}>{t('common.cancel')}</Button>
                  </div>
                </div>
              ) : null}

              {approveRun.error ? <div className="error-banner">{t('ops.runSpecs.approveErrorPrefix', { error: String(approveRun.error) })}</div> : null}
              {rejectRun.error ? <div className="error-banner">{t('ops.runSpecs.rejectErrorPrefix', { error: String(rejectRun.error) })}</div> : null}
              {verifyRun.error ? <div className="error-banner">{t('ops.runSpecs.verifyErrorPrefix', { error: String(verifyRun.error) })}</div> : null}
            </div>
            <TopologyPanel runSpecId={selectedId} />
          </>
        ) : (
          <EmptyText text={t('ops.runSpecs.noStateData')} />
        )}
      </aside>
    </section>
  );
}
