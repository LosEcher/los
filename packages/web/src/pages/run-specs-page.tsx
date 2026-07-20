import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, X, Play, ShieldCheck } from 'lucide-react';
import { getJson, postJson } from '../api/index.js';
import { Button, DataTable, Fact, StatusPill, EmptyText } from '../ui.js';

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
  blockers?: string[];
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
    <section className="panel-grid">
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Run Specs</h2>
            <p>Task execution run specifications with phase and verification state.</p>
          </div>
          <StatusPill status={runList.length > 0 ? 'live' : 'partial'} />
        </div>
        <DataTable
          loading={runs.isLoading}
          empty="No run specs found."
          rows={runList}
          renderRow={(r) => (
            <div
              key={r.id}
              className={`record-row ${selectedId === r.id ? 'record-selected' : ''}`}
              onClick={() => setSelectedId(selectedId === r.id ? null : r.id)}
              style={{ cursor: 'pointer' }}
            >
              <div className="record-main">
                <div className="record-header">
                  <strong className="record-title" style={{ fontFamily: 'monospace', fontSize: 13 }}>
                    {r.id.slice(0, 16)}
                  </strong>
                  <span className={`status-pill ${r.status === 'succeeded' ? 'live' : r.status === 'failed' ? 'reserved' : 'partial'}`}>
                    {r.status}
                  </span>
                </div>
                <div className="record-meta">
                  {r.provider ? <span>{r.provider}/{r.model}</span> : null}
                  {r.sessionId ? <span> · session: {r.sessionId.slice(0, 12)}</span> : null}
                  <span> · {new Date(r.createdAt).toLocaleString()}</span>
                </div>
                {r.prompt ? (
                  <div className="record-detail" style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 4 }}>
                    {r.prompt.length > 200 ? r.prompt.slice(0, 200) + '...' : r.prompt}
                  </div>
                ) : null}
              </div>
            </div>
          )}
        />
      </div>

      <aside className="panel inspector">
        <div className="panel-head compact"><h2>Run State</h2></div>
        {!selectedId ? (
          <EmptyText text="Select a run spec to inspect its state." />
        ) : runState.isLoading ? (
          <EmptyText text="Loading..." />
        ) : runState.data ? (
          <>
            <div className="fact-list">
              <Fact label="phase" value={runState.data.phase ?? '—'} />
              <Fact label="action" value={runState.data.action ?? '—'} />
              <Fact label="tasks" value={String(runState.data.taskCount ?? 0)} />
              <Fact label="verifications" value={String(runState.data.verificationCount ?? 0)} />
              <Fact label="verifier" value={runState.data.verifierStatus ?? '—'} />
              {runState.data.approvalStatus ? (
                <Fact label="approval" value={runState.data.approvalStatus} />
              ) : null}
              {runState.data.blockers && runState.data.blockers.length > 0 ? (
                <div className="blocker-list">
                  <strong style={{ fontSize: 13 }}>Blockers</strong>
                  <ul style={{ margin: '4px 0 0 16px', fontSize: 13, color: 'var(--text-dim)' }}>
                    {(runState.data.blockers ?? []).map((b, i) => <li key={i}>{b}</li>)}
                  </ul>
                </div>
              ) : null}
            </div>

            <div className="section-divider" />
            <div className="panel-head compact"><h2>Operator Actions</h2></div>
            <div style={{ padding: '8px 16px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {!showApproval ? (
                  <Button variant="ghost" onClick={() => setShowApproval(true)} disabled={busy}>
                    <Play size={14} /> Approve / Reject
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  onClick={() => verifyRun.mutate(selectedId!)}
                  disabled={busy}
                >
                  <ShieldCheck size={14} /> {verifyRun.isPending ? 'Verifying…' : 'Verify'}
                </Button>
              </div>

              {showApproval ? (
                <div className="approval-panel">
                  <textarea
                    rows={2}
                    placeholder="Reason (optional) — sent as operator reason"
                    value={approvalReason}
                    onChange={e => setApprovalReason(e.target.value)}
                    style={{ width: '100%', marginBottom: 8 }}
                  />
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Button onClick={() => approveRun.mutate(selectedId!)} disabled={busy}>
                      <Check size={14} /> {approveRun.isPending ? 'Approving…' : 'Approve plan'}
                    </Button>
                    <Button variant="danger" onClick={() => rejectRun.mutate(selectedId!)} disabled={busy}>
                      <X size={14} /> {rejectRun.isPending ? 'Rejecting…' : 'Reject / cancel'}
                    </Button>
                    <Button variant="ghost" onClick={closeApprovalForm} disabled={busy}>Cancel</Button>
                  </div>
                </div>
              ) : null}

              {approveRun.error ? <div className="error-banner">Approve: {String(approveRun.error)}</div> : null}
              {rejectRun.error ? <div className="error-banner">Reject: {String(rejectRun.error)}</div> : null}
              {verifyRun.error ? <div className="error-banner">Verify: {String(verifyRun.error)}</div> : null}
            </div>
          </>
        ) : (
          <EmptyText text="No state data available." />
        )}
      </aside>
    </section>
  );
}
