/** Display-only registry filters. Keep in sync with nodes-registry-filter.ts.
 *
 * ADR 0048 / audit migration item D1: **unknown is not offline** — a row whose
 * status is missing or unrecognized is `unknown`, never `offline`.
 */

export const DEFAULT_NODE_REGISTRY_FILTER = 'executors';

/** Liveness of a registry row; anything unrecognized is `unknown`, not `offline`. */
export function nodeLiveness(status) {
  if (status === 'online') return 'online';
  if (status === 'draining') return 'draining';
  if (status === 'offline') return 'offline';
  return 'unknown';
}

/** Default `executors` view: every executor that is not confirmed offline. */
export function filterRegistryNodes(nodes, filter) {
  const list = Array.isArray(nodes) ? nodes : [];
  if (filter === 'ssh') return list.filter(node => node.nodeKind === 'ssh_target');
  if (filter === 'all') return list;
  return list.filter(node => node.nodeKind === 'executor' && nodeLiveness(node.status) !== 'offline');
}

export function countRegistryFilters(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const executors = list.filter(node => node.nodeKind === 'executor');
  const visible = executors.filter(node => nodeLiveness(node.status) !== 'offline');
  return {
    executors: visible.length,
    executorsDraining: visible.filter(node => nodeLiveness(node.status) === 'draining').length,
    executorsUnknown: visible.filter(node => nodeLiveness(node.status) === 'unknown').length,
    ssh: list.filter(node => node.nodeKind === 'ssh_target').length,
    all: list.length,
  };
}
