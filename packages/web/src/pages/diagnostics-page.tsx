import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getJson } from '../api/index.js';
import { DataTable, EmptyText, StatusPill } from '../ui.js';
import { useI18n } from '../i18n';

interface TraceSummary {
  traceId: string;
  requestId: string | null;
  sessionId: string | null;
  startedAt: string | null;
  lastEventAt: string | null;
  eventCount: number;
  errorCount: number;
  model: string | null;
}

interface ProviderHealth {
  provider: string;
  totalCalls: number;
  successRate: number;
  avgLatencyMs: number;
  repairCount: number;
  errorBreakdown: Record<string, number>;
}

interface SpanNode {
  eventId: number;
  type: string;
  parentEventId: number | null;
  sessionId: string;
  turn: number;
  model: string | null;
  toolName: string | null;
  createdAt: string;
  orphan: boolean;
  children: SpanNode[];
}

interface TraceTaskRun {
  id: string;
  runSpecId: string | null;
  sessionId: string | null;
  status: string;
  provider: string | null;
  model: string | null;
  startedAt: string | null;
  completedAt: string | null;
  attempt: number;
}

interface TraceTodo {
  id: string;
  title: string;
  status: string;
  priority: string | null;
  kind: string | null;
  createdAt: string;
}

interface TraceProviderCall {
  provider: string;
  model: string;
  endpoint: string;
  status: number;
  durationMs: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
}

interface TraceDetail {
  traceId: string;
  requestId: string | null;
  runSpec: Record<string, unknown> | null;
  session: Record<string, unknown> | null;
  eventCount: number;
  providerCallCount: number;
  errors: Array<Record<string, unknown>>;
  timeline: Array<{ timestamp: string; source: string; type: string; summary?: string }>;
  taskRuns: TraceTaskRun[];
  todos: TraceTodo[];
  spanTree: SpanNode[];
  providerCalls: TraceProviderCall[];
}

/** 递归渲染 span 树。 */
function SpanTreeView({ nodes, depth }: { nodes: SpanNode[]; depth: number }) {
  const { t } = useI18n();
  return (
    <>
      {nodes.map(node => (
        <div key={node.eventId} className="diag-span-node" style={{ paddingLeft: `${depth * 18}px` }}>
          <span className={`diag-span-type${node.orphan ? ' is-orphan' : ''}`}>{node.type}</span>
          {node.model ? <span className="diag-span-meta">model: {node.model}</span> : null}
          {node.toolName ? <span className="diag-span-meta">tool: {node.toolName}</span> : null}
          <span className="diag-span-meta">#{node.eventId}</span>
          {node.orphan ? <span className="status-pill live">{t('ops.diagnostics.orphanLabel')}</span> : null}
          <span className="diag-span-time">{new Date(node.createdAt).toLocaleTimeString()}</span>
          {node.children.length > 0 ? <SpanTreeView nodes={node.children} depth={depth + 1} /> : null}
        </div>
      ))}
    </>
  );
}

export function DiagnosticsPage() {
  const { t } = useI18n();
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);

  const traces = useQuery({
    queryKey: ['diagnostics'],
    queryFn: () => getJson<{ traces: TraceSummary[] }>('/diagnostics'),
    refetchInterval: 30_000,
  });

  const providerHealth = useQuery({
    queryKey: ['provider-health'],
    queryFn: () => getJson<{ providers: ProviderHealth[] }>('/diagnostics/provider-health'),
    refetchInterval: 60_000,
  });

  const traceDetail = useQuery({
    queryKey: ['diagnostics-trace', selectedTraceId],
    queryFn: () => getJson<TraceDetail>(`/diagnostics/${encodeURIComponent(selectedTraceId!)}`),
    enabled: Boolean(selectedTraceId),
    refetchInterval: 15_000,
  });

  const traceList = traces.data?.traces ?? [];
  const healthList = providerHealth.data?.providers ?? [];
  const detail = traceDetail.data;

  return (
    <section className="panel-grid ops-page">
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
            <button
              key={trace.traceId}
              type="button"
              className={`record-row record-row-stack record-row-button${selectedTraceId === trace.traceId ? ' is-selected' : ''}`}
              onClick={() => setSelectedTraceId(selectedTraceId === trace.traceId ? null : trace.traceId)}
            >
              <div className="record-main">
                <div className="record-header">
                  <strong className="record-title">{trace.traceId.slice(0, 16)}</strong>
                  {trace.errorCount > 0 ? <span className="status-pill live">{t('ops.diagnostics.errorsLabel', { count: trace.errorCount })}</span> : null}
                </div>
                <div className="record-meta">
                  {trace.sessionId ? <span>{t('ops.diagnostics.sessionShort', { id: trace.sessionId.slice(0, 12) })}</span> : null}
                  {trace.model ? <span>{trace.model}</span> : null}
                  <span>{t('ops.diagnostics.eventsLabel', { count: trace.eventCount })}</span>
                  <span>{trace.startedAt ? new Date(trace.startedAt).toLocaleString() : ''}</span>
                </div>
              </div>
            </button>
          )}
        />
      </div>

      {/* ── Trace Detail ─────────────────────────────── */}
      {selectedTraceId ? (
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>{t('ops.diagnostics.detailTitle')}</h2>
              <p className="record-meta">
                <code>{selectedTraceId}</code>
                {detail?.requestId ? <span> · {t('ops.diagnostics.requestIdLabel')}: {detail.requestId}</span> : null}
                {detail?.session ? <span> · session: {String(detail.session.id ?? '').slice(0, 12)}</span> : null}
              </p>
            </div>
            {detail ? <StatusPill status={detail.errors.length > 0 ? 'live' : 'reserved'} /> : null}
          </div>

          {traceDetail.isLoading ? <EmptyText text={t('common.loading')} /> : null}
          {traceDetail.error ? <EmptyText text={t('ops.diagnostics.detailLoadError')} /> : null}

          {detail ? (
            <>
              <div className="fact-list compact-facts" style={{ marginBottom: '0.75rem' }}>
                <span className="fact"><b>{detail.eventCount}</b> {t('ops.diagnostics.eventsLabel', { count: detail.eventCount })}</span>
                <span className="fact"><b>{detail.providerCallCount}</b> provider calls</span>
                <span className="fact"><b>{detail.errors.length}</b> {t('ops.diagnostics.errorsLabel', { count: detail.errors.length })}</span>
                <span className="fact"><b>{detail.taskRuns.length}</b> task runs</span>
                <span className="fact"><b>{detail.todos.length}</b> todos</span>
              </div>

              {/* Span tree */}
              <h3 className="diag-subhead">{t('ops.diagnostics.spanTreeTitle')}</h3>
              {detail.spanTree.length === 0 ? (
                <EmptyText text={t('ops.diagnostics.noSpanTree')} />
              ) : (
                <div className="diag-span-tree">
                  <SpanTreeView nodes={detail.spanTree} depth={0} />
                </div>
              )}

              {/* Timeline */}
              <h3 className="diag-subhead">{t('ops.diagnostics.timelineTitle')}</h3>
              {detail.timeline.length === 0 ? (
                <EmptyText text={t('ops.diagnostics.noTimeline')} />
              ) : (
                <div className="diag-timeline">
                  {detail.timeline.map((item, idx) => (
                    <div key={idx} className="diag-timeline-row">
                      <span className={`status-pill ${item.source === 'provider' ? 'live' : 'ok'}`}>{item.source}</span>
                      <code>{item.type}</code>
                      {item.summary ? <span className="diag-timeline-summary">{item.summary}</span> : null}
                      <span className="diag-span-time">{new Date(item.timestamp).toLocaleTimeString()}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Task runs */}
              {detail.taskRuns.length > 0 ? (
                <>
                  <h3 className="diag-subhead">{t('ops.diagnostics.taskRunsTitle')}</h3>
                  <table className="project-table" style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th>id</th><th>{t('ops.diagnostics.thStatus')}</th><th>{t('ops.diagnostics.thProvider')}</th><th>model</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.taskRuns.map(tr => (
                        <tr key={tr.id}>
                          <td><code>{tr.id.slice(0, 20)}</code></td>
                          <td><span className="status-pill">{tr.status}</span></td>
                          <td>{tr.provider ?? '—'}</td>
                          <td>{tr.model ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : null}

              {/* Provider calls */}
              {detail.providerCalls.length > 0 ? (
                <>
                  <h3 className="diag-subhead">{t('ops.diagnostics.providerCallsTitle')}</h3>
                  <table className="project-table" style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th>{t('ops.diagnostics.thProvider')}</th><th>model</th><th>endpoint</th>
                        <th>{t('ops.diagnostics.thStatus')}</th><th>duration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.providerCalls.map((pc, idx) => (
                        <tr key={idx}>
                          <td>{pc.provider}</td><td>{pc.model}</td>
                          <td><code>{pc.endpoint}</code></td>
                          <td><span style={{ color: pc.status >= 400 ? 'var(--red)' : 'inherit' }}>{pc.status}</span></td>
                          <td>{pc.durationMs}ms</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

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
