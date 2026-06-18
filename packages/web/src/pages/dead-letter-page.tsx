import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle } from 'lucide-react';
import { getJson, postJson } from '../api/index.js';
import { DataTable, EmptyText, StatusPill, Fact } from '../ui.js';

interface DeadLetterEvent {
  id: string;
  taskRunId: string | null;
  runSpecId: string | null;
  reason: string;
  originalError: string | null;
  eventPayload: Record<string, unknown>;
  acknowledgedAt: string | null;
  createdAt: string;
}

export function DeadLetterPage() {
  const queryClient = useQueryClient();

  const dlq = useQuery({
    queryKey: ['dead-letter'],
    queryFn: () => getJson<DeadLetterEvent[]>('/tasks/dead-letter?limit=200'),
    refetchInterval: 30_000,
  });

  const ack = useMutation({
    mutationFn: (id: string) => postJson<DeadLetterEvent>(`/tasks/dead-letter/${id}/ack`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dead-letter'] });
    },
  });

  const events = dlq.data ?? [];
  const unacked = events.filter(e => !e.acknowledgedAt);
  const acked = events.filter(e => e.acknowledgedAt);

  return (
    <section className="panel-grid">
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Dead Letter Queue</h2>
            <p>Unacknowledged failures from task runs and run specs. Acknowledge after investigation.</p>
          </div>
          <StatusPill status={unacked.length > 0 ? 'live' : 'partial'} />
        </div>

        <div className="fact-list" style={{ marginBottom: 16 }}>
          <Fact label="unacknowledged" value={String(unacked.length)} />
          <Fact label="acknowledged" value={String(acked.length)} />
          <Fact label="total" value={String(events.length)} />
        </div>

        <DataTable
          loading={dlq.isLoading}
          empty="No dead letter events."
          rows={events}
          renderRow={(e) => (
            <div key={e.id} className={`record-row ${e.acknowledgedAt ? 'record-dim' : ''}`}>
              <div className="record-main">
                <div className="record-header">
                  <strong className="record-title">{e.reason}</strong>
                  {e.acknowledgedAt ? (
                    <span className="status-pill partial">acked</span>
                  ) : (
                    <button
                      type="button"
                      className="ghost-btn tiny-btn"
                      onClick={() => ack.mutate(e.id)}
                      disabled={ack.isPending}
                    >
                      <CheckCircle size={12} /> ack
                    </button>
                  )}
                </div>
                <div className="record-meta">
                  {e.taskRunId ? <span>task: {e.taskRunId.slice(0, 12)}</span> : null}
                  {e.runSpecId ? <span> · run: {e.runSpecId.slice(0, 12)}</span> : null}
                  <span> · {new Date(e.createdAt).toLocaleString()}</span>
                  {e.acknowledgedAt ? <span> · acked: {new Date(e.acknowledgedAt).toLocaleString()}</span> : null}
                </div>
                {e.originalError ? (
                  <div className="record-detail" style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 4 }}>
                    {e.originalError.length > 300 ? e.originalError.slice(0, 300) + '...' : e.originalError}
                  </div>
                ) : null}
              </div>
            </div>
          )}
        />
      </div>
    </section>
  );
}
