/**
 * Display-only registry filters.
 *
 * ADR 0048 / audit migration item D1: **unknown is not offline**. A registry row
 * whose status is missing or unrecognized projects to `unknown`, never to
 * `offline` — otherwise a page that has not received data yet (or a status a newer
 * gateway added) claims a node is down.
 */

export type RegistryNode = {
  nodeId: string;
  nodeKind: string;
  status: string;
};

export type NodeRegistryFilter = 'executors' | 'ssh' | 'all';
export const DEFAULT_NODE_REGISTRY_FILTER: NodeRegistryFilter = 'executors';

export type NodeLiveness = 'online' | 'draining' | 'offline' | 'unknown';

/** Liveness of a registry row; anything unrecognized is `unknown`, not `offline`. */
export function nodeLiveness(status: string | null | undefined): NodeLiveness {
  if (status === 'online') return 'online';
  if (status === 'draining') return 'draining';
  if (status === 'offline') return 'offline';
  return 'unknown';
}

/**
 * Default `executors` view: every executor that is **not confirmed offline**.
 *
 * Draining rows (a rollout in progress) and unknown rows (no data yet, or a status
 * this build does not recognize) stay visible. Hiding them is the same false claim
 * as rendering unknown as offline: the operator sees "nothing to see" while a node
 * is mid-rollout or has stopped reporting inside the staleness window.
 */
export function filterRegistryNodes<T extends Pick<RegistryNode, 'nodeKind' | 'status'>>(
  nodes: T[] | undefined,
  filter: string,
): T[] {
  const list = nodes ?? [];
  if (filter === 'ssh') return list.filter(node => node.nodeKind === 'ssh_target');
  if (filter === 'all') return list;
  return list.filter(node => node.nodeKind === 'executor' && nodeLiveness(node.status) !== 'offline');
}

export function countRegistryFilters(nodes: Array<Pick<RegistryNode, 'nodeKind' | 'status'>> | undefined) {
  const list = nodes ?? [];
  const executors = list.filter(node => node.nodeKind === 'executor');
  const visible = executors.filter(node => nodeLiveness(node.status) !== 'offline');
  return {
    // `executors` counts exactly what the executors tab shows; the breakdown below
    // lets the UI say "3 online · 1 draining · 1 unknown" instead of implying every
    // visible node is serving.
    executors: visible.length,
    executorsDraining: visible.filter(node => nodeLiveness(node.status) === 'draining').length,
    executorsUnknown: visible.filter(node => nodeLiveness(node.status) === 'unknown').length,
    ssh: list.filter(node => node.nodeKind === 'ssh_target').length,
    all: list.length,
  };
}
