/**
 * @los/agent/static-graph-baselines — Capture and compare execution static graph snapshots.
 *
 * Used by the governance sweeper (architecture_drift) to detect structural
 * changes: new entrypoints, removed routes, changed call chains.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';

const log = getLogger('static-graph-baselines');

export interface StaticGraphBaseline {
  id: string;
  label: string;
  graph: {
    nodes: Array<{ id: string; kind: string; label: string; file?: string; path?: string }>;
    edges: Array<{ from: string; to: string; kind: string; label?: string }>;
    warnings: string[];
  };
  nodeCount: number;
  edgeCount: number;
  capturedBy?: string;
  capturedAt: string;
  previousBaselineId?: string;
  tenantId?: string;
  projectId?: string;
  createdAt: string;
}

export interface CaptureBaselineInput {
  graph: StaticGraphBaseline['graph'];
  label?: string;
  capturedBy?: string;
  tenantId?: string;
  projectId?: string;
}

export interface BaselineDiff {
  baselineId: string;
  previousBaselineId?: string;
  newNodeIds: string[];
  removedNodeIds: string[];
  newEdges: Array<{ from: string; to: string; kind: string }>;
  removedEdges: Array<{ from: string; to: string; kind: string }>;
  changedNodeKinds: Array<{ id: string; oldKind: string; newKind: string }>;
  warningChanges: { added: string[]; removed: string[] };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS static_graph_baselines (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  graph_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  node_count INTEGER NOT NULL DEFAULT 0,
  edge_count INTEGER NOT NULL DEFAULT 0,
  captured_by TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  previous_baseline_id TEXT,
  tenant_id TEXT,
  project_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sgb_label ON static_graph_baselines(label);
CREATE INDEX IF NOT EXISTS idx_sgb_captured_at ON static_graph_baselines(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_sgb_tenant_project ON static_graph_baselines(tenant_id, project_id);
`;

let _initialized = false;

export async function ensureStaticGraphBaselineStore(): Promise<void> {
  if (_initialized) return;
  await getDb().exec(SCHEMA);
  _initialized = true;
  log.info('Static graph baseline store initialized');
}

export async function captureStaticGraphBaseline(
  input: CaptureBaselineInput,
): Promise<StaticGraphBaseline> {
  await ensureStaticGraphBaselineStore();
  const db = getDb();

  const latest = await getLatestBaseline({
    tenantId: input.tenantId,
    projectId: input.projectId,
  });

  const id = `sgb-${randomUUID()}`;
  const now = new Date().toISOString();

  const rows = await db.query<BaselineRow>(
    `INSERT INTO static_graph_baselines (
      id, label, graph_json, node_count, edge_count,
      captured_by, captured_at, previous_baseline_id, tenant_id, project_id
    ) VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *`,
    [
      id,
      input.label ?? `capture-${now}`,
      JSON.stringify(input.graph),
      input.graph.nodes.length,
      input.graph.edges.length,
      input.capturedBy ?? null,
      now,
      latest?.id ?? null,
      input.tenantId ?? null,
      input.projectId ?? null,
    ],
  );

  return rowToBaseline(assertRow(rows.rows[0]));
}

export async function getLatestBaseline(opts?: {
  tenantId?: string;
  projectId?: string;
}): Promise<StaticGraphBaseline | null> {
  await ensureStaticGraphBaselineStore();
  const db = getDb();
  const params: unknown[] = [];
  const clauses: string[] = [];

  if (opts?.tenantId) {
    params.push(opts.tenantId);
    clauses.push(`(tenant_id IS NULL OR tenant_id = $${params.length})`);
  }
  if (opts?.projectId) {
    params.push(opts.projectId);
    clauses.push(`(project_id IS NULL OR project_id = $${params.length})`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await db.query<BaselineRow>(
    `SELECT * FROM static_graph_baselines ${where}
     ORDER BY captured_at DESC, id LIMIT 1`,
    params,
  );

  return rows.rows[0] ? rowToBaseline(rows.rows[0]) : null;
}

export async function getBaseline(id: string): Promise<StaticGraphBaseline | null> {
  await ensureStaticGraphBaselineStore();
  const rows = await getDb().query<BaselineRow>(
    'SELECT * FROM static_graph_baselines WHERE id = $1',
    [id],
  );
  return rows.rows[0] ? rowToBaseline(rows.rows[0]) : null;
}

export async function deleteBaseline(id: string): Promise<boolean> {
  await ensureStaticGraphBaselineStore();
  const result = await getDb().query<{ id: string }>(
    'DELETE FROM static_graph_baselines WHERE id = $1 RETURNING id',
    [id],
  );
  return result.rows.length > 0;
}

export function diffBaselines(
  current: StaticGraphBaseline['graph'],
  previous: StaticGraphBaseline['graph'],
): BaselineDiff {
  const curNodeIds = new Set(current.nodes.map(n => n.id));
  const prevNodeIds = new Set(previous.nodes.map(n => n.id));
  const prevNodeMap = new Map(previous.nodes.map(n => [n.id, n]));

  const newNodeIds = [...curNodeIds].filter(id => !prevNodeIds.has(id));
  const removedNodeIds = [...prevNodeIds].filter(id => !curNodeIds.has(id));

  const changedNodeKinds: BaselineDiff['changedNodeKinds'] = [];
  for (const id of curNodeIds) {
    if (!prevNodeIds.has(id)) continue;
    const curNode = current.nodes.find(n => n.id === id)!;
    const prevNode = prevNodeMap.get(id)!;
    if (curNode.kind !== prevNode.kind) {
      changedNodeKinds.push({ id, oldKind: prevNode.kind, newKind: curNode.kind });
    }
  }

  const edgeKey = (e: { from: string; to: string; kind: string }) =>
    `${e.from}→${e.to}→${e.kind}`;
  const curEdges = new Set(current.edges.map(edgeKey));
  const prevEdges = new Set(previous.edges.map(edgeKey));

  const newEdges = current.edges.filter(e => !prevEdges.has(edgeKey(e)));
  const removedEdges = previous.edges.filter(e => !curEdges.has(edgeKey(e)));

  const curWarnings = new Set(current.warnings);
  const prevWarnings = new Set(previous.warnings);
  const warningChanges = {
    added: current.warnings.filter(w => !prevWarnings.has(w)),
    removed: previous.warnings.filter(w => !curWarnings.has(w)),
  };

  return {
    baselineId: '',
    newNodeIds,
    removedNodeIds,
    newEdges,
    removedEdges,
    changedNodeKinds,
    warningChanges,
  };
}

export function summarizeBaselineDiff(diff: BaselineDiff): {
  hasChanges: boolean;
  summary: string;
} {
  const parts: string[] = [];
  if (diff.newNodeIds.length > 0) parts.push(`${diff.newNodeIds.length} new nodes`);
  if (diff.removedNodeIds.length > 0) parts.push(`${diff.removedNodeIds.length} removed nodes`);
  if (diff.newEdges.length > 0) parts.push(`${diff.newEdges.length} new edges`);
  if (diff.removedEdges.length > 0) parts.push(`${diff.removedEdges.length} removed edges`);
  if (diff.changedNodeKinds.length > 0) parts.push(`${diff.changedNodeKinds.length} kind changes`);
  const hasChanges = parts.length > 0;
  return {
    hasChanges,
    summary: hasChanges ? parts.join(', ') : 'no structural changes',
  };
}

type BaselineRow = {
  id: string;
  label: string;
  graph_json: unknown;
  node_count: string | number;
  edge_count: string | number;
  captured_by: string | null;
  captured_at: Date | string;
  previous_baseline_id: string | null;
  tenant_id: string | null;
  project_id: string | null;
  created_at: Date | string;
};

function rowToBaseline(row: BaselineRow): StaticGraphBaseline {
  const graph = normalizeJsonObject(row.graph_json);
  return {
    id: row.id,
    label: row.label,
    graph: {
      nodes: Array.isArray(graph.nodes) ? graph.nodes as StaticGraphBaseline['graph']['nodes'] : [],
      edges: Array.isArray(graph.edges) ? graph.edges as StaticGraphBaseline['graph']['edges'] : [],
      warnings: Array.isArray(graph.warnings)
        ? (graph.warnings as string[]).filter((w): w is string => typeof w === 'string')
        : [],
    },
    nodeCount: Number(row.node_count),
    edgeCount: Number(row.edge_count),
    capturedBy: row.captured_by ?? undefined,
    capturedAt: toIsoString(row.captured_at),
    previousBaselineId: row.previous_baseline_id ?? undefined,
    tenantId: row.tenant_id ?? undefined,
    projectId: row.project_id ?? undefined,
    createdAt: toIsoString(row.created_at),
  };
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { return {}; }
  }
  return {};
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('static_graph_baselines write returned no row');
  return row;
}
