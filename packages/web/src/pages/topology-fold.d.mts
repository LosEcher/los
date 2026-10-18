export type FoldGraphNode = {
  id: string;
  kind: string;
  label: string;
  recordId: string;
  record: Record<string, unknown>;
};

export type FoldGraphEdge = {
  from: string;
  to: string;
  kind: string;
  label?: string;
};

export type FoldInput = {
  nodes: FoldGraphNode[];
  edges: FoldGraphEdge[];
};

export type FoldGroupRecord = {
  foldedKind: string;
  owner: string | null;
  memberIds: string[];
  memberKinds: Record<string, number>;
  count: number;
};

export type FoldStats = {
  foldedNodes: number;
  groups: number;
  memberTouchedEdges: number;
  rewrittenEdges: number;
  dedupedRewrites: number;
  internalEdgesDropped: number;
  crossGroupEdges: number;
  keptEdges: number;
};

export type FoldResult = {
  nodes: FoldGraphNode[];
  edges: FoldGraphEdge[];
  stats: FoldStats;
  foldedMemberIds: string[];
};

export const DEFAULT_FOLD_KINDS: string[];
export function foldEvidenceGraph(graph: FoldInput, options?: { foldKinds?: string[] }): FoldResult;
