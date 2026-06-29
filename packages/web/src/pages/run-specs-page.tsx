import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, X, Play } from 'lucide-react';
import { getJson, postJson } from '../api/index.js';
import { Button, DataTable, Fact, StatusPill, EmptyText, Badge } from '../ui.js';

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

export function RunSpecsPage() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [approvalNote, setApprovalNote] = useState('');
  const [showApproval, setShowApproval] = useState(false);

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

  // ── Approval actions (scaffold — route tests pending) ─
  const approveRun = useMutation({
    mutationFn: (id: string) => postJson(`/runs/${id}/approve`, { approved: true, note: approvalNote.trim() || undefined }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['runs'] }); qc.invalidateQueries({ queryKey: ['run-state', selectedId] }); setShowApproval(false); setApprovalNote(''); },
  });
  const rejectRun = useMutation({
    mutationFn: (id: string) => postJson(`/runs/${id}/approve`, { approved: false, note: approvalNote.trim() || 'operator rejected' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['runs'] }); qc.invalidateQueries({ queryKey: ['run-state', selectedId] }); setShowApproval(false); setApprovalNote(''); },
  });

  const runList = runs.data ?? [];

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

      {/* ── Run State Inspector ───────────────────────────── */}
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

            {/* ── Operator Approval Section ──────────────── */}
            <div className="section-divider" />
            <div className="panel-head compact"><h2>Operator Approval</h2></div>
            {!showApproval ? (
              <div style={{ padding: '8px 16px 16px' }}>
                <Button variant="ghost" onClick={() => setShowApproval(true)}>
                  <Play size={14} /> Approve / Reject
                </Button>
              </div>
            ) : (
              <div className="approval-panel">
                <textarea
                  rows={2}
                  placeholder="Approval note (optional)..."
                  value={approvalNote}
                  onChange={e => setApprovalNote(e.target.value)}
                  style={{ width: '100%', marginBottom: 8 }}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button onClick={() => approveRun.mutate(selectedId!)} disabled={approveRun.isPending}>
                    <Check size={14} /> {approveRun.isPending ? 'Approving…' : 'Approve'}
                  </Button>
                  <Button variant="danger" onClick={() => rejectRun.mutate(selectedId!)} disabled={rejectRun.isPending}>
                    <X size={14} /> {rejectRun.isPending ? 'Rejecting…' : 'Reject'}
                  </Button>
                  <Button variant="ghost" onClick={() => setShowApproval(false)}>Cancel</Button>
                </div>
                {approveRun.error ? <div className="error-banner">Approve: {String(approveRun.error)}</div> : null}
                {rejectRun.error ? <div className="error-banner">Reject: {String(rejectRun.error)}</div> : null}
              </div>
            )}
          </>
        ) : (
          <EmptyText text="No state data available." />
        )}
      </aside>
    </section>
  );
}
