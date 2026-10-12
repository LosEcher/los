export type FleetTopologyRecord = Record<string, unknown>;

export type FleetTopologyNode = {
  id: string;
  kind: string;
  label: string;
  recordId: string;
  record: FleetTopologyRecord;
};

export type FleetTopologyEdge = {
  from: string;
  to: string;
  kind: string;
  label?: string;
};

export type FleetTopologyDerived = {
  recordId: string;
  status: string | null;
  hostLabel: string | null;
  runs: number;
  succeeded: number;
  failed: number;
  blocked: number;
  lastAt: string | null;
  candidate: boolean | null;
  blockers: number;
  reason: string | null;
  decision: unknown;
};

export type FleetTopologyLayoutNode = FleetTopologyNode & {
  x: number;
  y: number;
  column: string;
  label: string;
  fullLabel: string;
  derived: FleetTopologyDerived;
};

export type FleetTopologyLayout = {
  nodes: FleetTopologyLayoutNode[];
  edges: FleetTopologyEdge[];
  droppedEdges: FleetTopologyEdge[];
  columns: Array<{ kind: string; x: number; count: number; subColumns: number }>;
  width: number;
  height: number;
  stats: {
    inputNodes: number;
    placedNodes: number;
    unplaced: number;
    inputEdges: number;
    drawnEdges: number;
    droppedEdges: number;
  };
};

export const FLEET_COLUMNS: string[];
export const FLEET_MAX_ROWS: number;
export const FLEET_NODE_W: number;
export const FLEET_ROW_H: number;
export const FLEET_COL_GAP: number;
export const FLEET_PAD: number;
export const FLEET_MAX_LABEL_UNITS: number;
export function clipLabel(label: unknown, maxUnits?: number): string;
export function buildFleetTopologyLayout(graph: { nodes?: FleetTopologyNode[]; edges?: FleetTopologyEdge[] }): FleetTopologyLayout;
