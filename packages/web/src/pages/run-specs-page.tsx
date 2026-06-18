import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getJson } from '../api/index.js';
import { DataTable, Fact, StatusPill, EmptyText } from '../ui.js';

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
}

export function RunSpecsPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
          <div className="fact-list">
            <Fact label="phase" value={runState.data.phase ?? '—'} />
            <Fact label="action" value={runState.data.action ?? '—'} />
            <Fact label="tasks" value={String(runState.data.taskCount ?? 0)} />
            <Fact label="verifications" value={String(runState.data.verificationCount ?? 0)} />
            <Fact label="verifier" value={runState.data.verifierStatus ?? '—'} />
            {runState.data.blockers && runState.data.blockers.length > 0 ? (
              <div style={{ marginTop: 12 }}>
                <strong style={{ fontSize: 13 }}>Blockers</strong>
                <ul style={{ margin: '4px 0 0 16px', fontSize: 13, color: 'var(--text-dim)' }}>
                  {runState.data.blockers.map((b, i) => <li key={i}>{b}</li>)}
                </ul>
              </div>
            ) : null}
          </div>
        ) : (
          <EmptyText text="No state data available." />
        )}
      </aside>
    </section>
  );
}
