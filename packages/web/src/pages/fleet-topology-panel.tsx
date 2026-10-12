import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Network, Server, Waypoints } from 'lucide-react';

import { getJson } from '../api/index.js';
import { errorMessage } from '../node-editor.js';
import { EmptyText, formatDate } from '../ui.js';
import { useI18n } from '../i18n';
import { buildFleetTopologyLayout, type FleetTopologyLayout } from './fleet-topology-layout.mjs';

/**
 * 机队拓扑面板 —— 消费 `GET /topology/fleet`（operator 门禁）。
 *
 * 三条与"能画出来"同等重要的显示纪律：
 *   1. **声明与观测分开**：节点来自注册表（这台机器登记在册），边来自落点观测（它真的承接了任务）。
 *      所以"注册了但没跑过"的节点会画出来但**没有边**——这是信息，不是缺漏。
 *   2. **降级必须可见**：服务端的 `degraded/warnings` 直接显示在图上（截断、闭集外的 kind 等），
 *      不允许面板把它吞掉；`asOf` 也显示（否则读者无法判断这是不是"现在"）。
 *   3. **口径只读服务端**：所有数字来自响应里的 `record`，面板不重算任何指标（见 layout 模块）。
 */

export interface FleetTopologyGraph {
  nodes: Array<{ id: string; kind: string; label: string; recordId: string; record: Record<string, unknown> }>;
  edges: Array<{ from: string; to: string; kind: string; label?: string }>;
  counts: Record<string, number>;
  warnings: string[];
  degraded: { isDegraded: boolean; reasons: string[] };
  asOf: string;
  sources: Array<{ id: string; kind: string; asOf: string; detail: string }>;
}

const NODE_H = 30;
const KIND_TONE: Record<string, string> = {
  gateway: '#f0b429',
  executor: '#4ade80',
  ssh_target: '#64748b',
  placement_only: '#f87171',
  unknown: '#94a3b8',
};

export function FleetTopologyPanel() {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['fleet-topology'],
    queryFn: () => getJson<FleetTopologyGraph>('/topology/fleet'),
    refetchInterval: 30_000,
  });

  const layout: FleetTopologyLayout | null = useMemo(
    () => (query.data ? buildFleetTopologyLayout(query.data) : null),
    [query.data],
  );
  const selected = selectedId === null ? null : layout?.nodes.find(node => node.id === selectedId) ?? null;

  if (query.isLoading) return <EmptyText text={t('ops.nodes.topology.loading')} />;
  if (query.isError) {
    return <EmptyText text={t('ops.nodes.topology.loadFailed', { error: errorMessage(query.error) })} />;
  }
  if (!layout || layout.nodes.length === 0) {
    return <EmptyText text={t('ops.nodes.topology.empty')} />;
  }
  const graph = query.data as FleetTopologyGraph;

  return (
    <div className="fleet-topology" aria-label={t('ops.nodes.topology.sectionAria')}>
      <div className="fleet-topology-head">
        <Network size={14} />
        <strong>{t('ops.nodes.topology.title')}</strong>
        <span className="muted">
          {t('ops.nodes.topology.stats', {
            nodes: String(layout.stats.placedNodes),
            edges: String(layout.stats.drawnEdges),
          })}
        </span>
        <span className="muted">{t('ops.nodes.topology.asOf', { at: formatDate(graph.asOf) })}</span>
      </div>

      {graph.degraded?.isDegraded ? (
        <div className="fleet-topology-degraded" role="status">
          <AlertTriangle size={13} />
          <div>
            <strong>{t('ops.nodes.topology.degraded')}</strong>
            <ul>
              {(graph.degraded.reasons ?? []).map(reason => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {/* 记账闭合：服务端给的边要么画出来要么显式列为丢弃；节点同理（unplaced）。 */}
      {layout.stats.unplaced > 0 || layout.droppedEdges.length > 0 ? (
        <div className="fleet-topology-degraded" role="status">
          <AlertTriangle size={13} />
          <span>
            {t('ops.nodes.topology.accounting', {
              unplaced: String(layout.stats.unplaced),
              dropped: String(layout.droppedEdges.length),
            })}
          </span>
        </div>
      ) : null}

      <div className="fleet-topology-canvas">
        <svg
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={t('ops.nodes.topology.svgAria')}
        >
          <defs>
            <marker id="fleet-topo-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="#94a3b8" />
            </marker>
          </defs>
          {layout.columns.map(column => (
            <text key={column.kind} x={column.x} y={12} className="fleet-topology-col-label">
              {t(`ops.nodes.topology.column.${column.kind}`, { count: String(column.count) })}
            </text>
          ))}
          {layout.edges.map((edge, index) => {
            const from = layout.nodes.find(node => node.id === edge.from);
            const to = layout.nodes.find(node => node.id === edge.to);
            if (!from || !to) return null;
            const x1 = from.x + 150;
            const y1 = from.y + NODE_H / 2;
            const x2 = to.x;
            const y2 = to.y + NODE_H / 2;
            const mid = (x1 + x2) / 2;
            return (
              <path
                key={`${edge.from}-${edge.to}-${index}`}
                d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke="#4ade80"
                strokeWidth={1.5}
                strokeDasharray="4 3"
                markerEnd="url(#fleet-topo-arrow)"
              />
            );
          })}
          {layout.nodes.map(node => {
            const tone = KIND_TONE[node.column] ?? KIND_TONE.unknown;
            const offline = node.derived?.status === 'offline';
            return (
              <g
                key={node.id}
                className="fleet-topology-node"
                transform={`translate(${node.x},${node.y})`}
                onClick={() => setSelectedId(node.id)}
                role="button"
                tabIndex={0}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') setSelectedId(node.id);
                }}
                aria-label={`${node.fullLabel} ${node.kind}`}
              >
                <title>{`${node.fullLabel} — ${node.kind}`}</title>
                <rect
                  width={150}
                  height={NODE_H}
                  rx={6}
                  fill={tone}
                  fillOpacity={offline ? 0.18 : 0.22}
                  stroke={tone}
                  strokeWidth={selectedId === node.id ? 2 : 1}
                />
                <text x={8} y={19} className="fleet-topology-node-label">
                  {node.label}
                </text>
                <text x={158} y={19} className="fleet-topology-node-metric">
                  {node.derived?.runs ? `${node.derived.runs}` : ''}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {selected ? (
        <div className="fleet-topology-detail">
          <div className="fleet-topology-detail-head">
            <Server size={13} />
            <code>{selected.kind}</code>
            <strong>{selected.fullLabel}</strong>
            {selected.derived?.status ? <span className="muted">{selected.derived.status}</span> : null}
          </div>
          <dl>
            <dt>{t('ops.nodes.topology.runs')}</dt>
            <dd>
              {selected.derived?.runs ?? 0}
              {' · '}
              {t('ops.nodes.topology.runsBreakdown', {
                succeeded: String(selected.derived?.succeeded ?? 0),
                failed: String(selected.derived?.failed ?? 0),
                blocked: String(selected.derived?.blocked ?? 0),
              })}
            </dd>
            <dt>{t('ops.nodes.topology.candidate')}</dt>
            <dd>{selected.derived?.candidate === null ? '-' : String(selected.derived?.candidate)}</dd>
            <dt>{t('ops.nodes.topology.blockers')}</dt>
            <dd>{selected.derived?.blockers ?? 0}</dd>
            {selected.derived?.reason ? (
              <>
                <dt>{t('ops.nodes.topology.placementReason')}</dt>
                <dd><code>{selected.derived.reason}</code></dd>
              </>
            ) : null}
            {selected.derived?.decision ? (
              <>
                <dt>{t('ops.nodes.topology.lastDecision')}</dt>
                <dd>
                  <code>{String((selected.derived.decision as { reason?: unknown }).reason ?? '')}</code>
                  {' · '}
                  {t('ops.nodes.topology.hasSelectionEvidence')}
                  {': '}
                  {String(Boolean((selected.derived.decision as { hasSelectionEvidence?: unknown }).hasSelectionEvidence))}
                </dd>
              </>
            ) : null}
            <dt>{t('ops.nodes.topology.recordId')}</dt>
            <dd><code>{selected.recordId}</code></dd>
          </dl>
        </div>
      ) : (
        <div className="muted fleet-topology-hint">{t('ops.nodes.topology.hint')}</div>
      )}

      <details className="fleet-topology-sources">
        <summary>
          <Waypoints size={12} />
          {t('ops.nodes.topology.sources', { count: String(graph.sources?.length ?? 0) })}
        </summary>
        <ul>
          {(graph.sources ?? []).map(source => (
            <li key={source.id}>
              <code>{source.id}</code> — {source.detail}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
