/**
 * TopologyPanel — execution evidence graph visualization for one run spec.
 *
 * Renders GET /runs/:id/inspect (RuntimeEvidenceGraph) as a layered SVG:
 *   run_spec → task_runs → agent_tasks (depends_on DAG) → task_attempts,
 * with session_events / tool_call_states / verification_records collapsed into
 * count badges. Click a node to inspect its record; hover for the label.
 *
 * Design reference: agent execution topology views (Langfuse trace trees,
 * AgentOps agent graphs) constrained to self-drawn SVG with no new deps.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { GitBranch, Network } from 'lucide-react';
import { getJson } from '../api/index.js';
import { EmptyText } from '../ui.js';
import { useI18n } from '../i18n';

export interface RuntimeEvidenceNode {
  id: string;
  kind: string;
  label: string;
  recordId: string;
  record: Record<string, unknown>;
}

export interface RuntimeEvidenceEdge {
  from: string;
  to: string;
  kind: string;
  label?: string;
}

export interface RuntimeEvidenceGraph {
  runSpecId: string;
  sessionId: string;
  nodes: RuntimeEvidenceNode[];
  edges: RuntimeEvidenceEdge[];
  counts: Record<string, number>;
  warnings: string[];
}

const NODE_W = 150;
const NODE_H = 30;
const LAYER_X = 235;
const ROW_Y = 62;

const KIND_COLORS: Record<string, string> = {
  run_spec: '#7c6cf0',
  task_run: '#3b82f6',
  agent_task: '#10b981',
  task_attempt: '#f59e0b',
};

const EDGE_COLORS: Record<string, string> = {
  has_task_run: '#3b82f6',
  depends_on: '#10b981',
  attempt_ran_as: '#f59e0b',
  emitted_event: '#94a3b8',
  has_tool_call_state: '#94a3b8',
  has_verification_record: '#94a3b8',
  has_session_event: '#cbd5e1',
  has_agent_task: '#10b981',
  has_task_attempt: '#f59e0b',
  parent_event: '#cbd5e1',
  attempt_verified_by: '#8b5cf6',
  attempt_used_tool_state: '#94a3b8',
};

type LayoutNode = RuntimeEvidenceNode & { x: number; y: number };

function layerIndex(kind: string): number {
  switch (kind) {
    case 'run_spec': return 0;
    case 'task_run': return 1;
    case 'agent_task': return 2;
    case 'task_attempt': return 3;
    default: return 4;
  }
}

function shortLabel(node: RuntimeEvidenceNode): string {
  const text = node.label || node.recordId;
  return text.length > 18 ? `${text.slice(0, 17)}…` : text;
}

function truncateRecord(record: Record<string, unknown>, maxChars: number): string {
  try {
    const text = JSON.stringify(record, null, 2);
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  } catch {
    return String(record);
  }
}

export function TopologyPanel({ runSpecId }: { runSpecId: string | null }) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['run-topology', runSpecId],
    queryFn: () => getJson<RuntimeEvidenceGraph & { state?: Record<string, unknown> }>(
      `/runs/${encodeURIComponent(runSpecId!)}/inspect`,
    ),
    enabled: Boolean(runSpecId),
    refetchInterval: 30_000,
  });

  const layout = useMemo<{ nodes: LayoutNode[]; visibleIds: Set<string>; width: number; height: number } | null>(() => {
    if (!query.data) return null;
    const visible = query.data.nodes.filter(node => layerIndex(node.kind) <= 3);
    const visibleIds = new Set(visible.map(node => node.id));
    const byLayer = new Map<number, LayoutNode[]>();
    for (const node of visible) {
      const layer = layerIndex(node.kind);
      const list = byLayer.get(layer) ?? [];
      list.push({ ...node, x: 0, y: 0 });
      byLayer.set(layer, list);
    }
    const placed: LayoutNode[] = [];
    let maxWidth = 0;
    const maxPerLayer = Math.max(...[...byLayer.values()].map(list => list.length), 1);
    const width = Math.max(360, maxPerLayer * (NODE_W + 24) + 24);
    for (const [layer, list] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
      const startX = (width - list.length * NODE_W - (list.length - 1) * 24) / 2;
      list.forEach((node, index) => {
        node.x = startX + index * (NODE_W + 24);
        node.y = layer * ROW_Y + 12;
      });
      placed.push(...list);
      maxWidth = Math.max(maxWidth, width);
    }
    const height = 4 * ROW_Y + 60;
    return { nodes: placed, visibleIds, width: maxWidth, height };
  }, [query.data]);

  const selectedNode = selectedId === null
    ? null
    : query.data?.nodes.find(node => node.id === selectedId) ?? null;

  const counts = query.data?.counts ?? {};
  const collapsedCount = (counts.session_event ?? 0) + (counts.tool_call_state ?? 0)
    + (counts.verification_record ?? 0);

  return (
    <section className="topology-panel" aria-label={t('assets.topology.sectionAria')}>
      <div className="topology-head">
        <Network size={14} />
        <strong>{t('assets.topology.title')}</strong>
        {query.data ? (
          <span className="topology-stats">
            {t('assets.topology.stats', {
              nodes: String(query.data.nodes.length),
              edges: String(query.data.edges.length),
            })}
          </span>
        ) : null}
      </div>

      {!runSpecId ? (
        <EmptyText text={t('assets.topology.selectPrompt')} />
      ) : query.isLoading ? (
        <EmptyText text={t('common.loading')} />
      ) : query.error ? (
        <p className="topology-error" role="alert">{t('assets.topology.loadError', { error: String(query.error) })}</p>
      ) : !layout || !query.data ? (
        <EmptyText text={t('assets.topology.unavailable')} />
      ) : (
        <>
          <div className="topology-svg-wrap">
            <svg
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              className="topology-svg"
              role="img"
              aria-label={t('assets.topology.svgAria')}
            >
              <defs>
                <marker id="topo-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                  <path d="M0,0 L8,4 L0,8 z" fill="#94a3b8" />
                </marker>
              </defs>
              {query.data.edges
                .filter(edge => layout.visibleIds.has(edge.from) && layout.visibleIds.has(edge.to))
                .map((edge, index) => {
                  const from = layout.nodes.find(node => node.id === edge.from);
                  const to = layout.nodes.find(node => node.id === edge.to);
                  if (!from || !to) return null;
                  const x1 = from.x + NODE_W;
                  const y1 = from.y + NODE_H / 2;
                  const x2 = to.x;
                  const y2 = to.y + NODE_H / 2;
                  const mid = (x1 + x2) / 2;
                  const color = EDGE_COLORS[edge.kind] ?? '#94a3b8';
                  return (
                    <path
                      key={index}
                      d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                      fill="none"
                      stroke={color}
                      strokeWidth="1.2"
                      strokeDasharray={edge.kind === 'depends_on' ? '0' : '4 3'}
                      opacity="0.75"
                      markerEnd="url(#topo-arrow)"
                    />
                  );
                })}
              {layout.nodes.map(node => (
                <g
                  key={node.id}
                  className={`topology-node${selectedId === node.id ? ' is-selected' : ''}`}
                  onClick={() => setSelectedId(selectedId === node.id ? null : node.id)}
                  role="button"
                  aria-label={`${node.kind} ${node.recordId}`}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedId(selectedId === node.id ? null : node.id);
                    }
                  }}
                >
                  <rect
                    x={node.x}
                    y={node.y}
                    width={NODE_W}
                    height={NODE_H}
                    rx="6"
                    fill={KIND_COLORS[node.kind] ?? '#64748b'}
                    fillOpacity="0.16"
                    stroke={KIND_COLORS[node.kind] ?? '#64748b'}
                    strokeWidth="1.2"
                  />
                  <text x={node.x + 8} y={node.y + NODE_H / 2 + 4} className="topology-node-label">
                    {shortLabel(node)}
                  </text>
                </g>
              ))}
            </svg>
          </div>

          {collapsedCount > 0 ? (
            <div className="topology-collapsed">
              <GitBranch size={12} />
              <span>{t('assets.topology.collapsed', { count: String(collapsedCount) })}</span>
            </div>
          ) : null}

          {selectedNode ? (
            <div className="topology-detail">
              <div className="topology-detail-head">
                <code>{selectedNode.kind}</code>
                <span>{selectedNode.recordId}</span>
              </div>
              <pre className="topology-detail-record">{truncateRecord(selectedNode.record, 1200)}</pre>
            </div>
          ) : (
            <p className="topology-hint">{t('assets.topology.hint')}</p>
          )}

          {query.data.warnings.length > 0 ? (
            <ul className="topology-warnings">
              {query.data.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </section>
  );
}
