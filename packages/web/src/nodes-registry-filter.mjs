/** Display-only registry filters. Keep in sync with nodes-registry-filter.ts. */

export const DEFAULT_NODE_REGISTRY_FILTER = 'executors';

export function filterRegistryNodes(nodes, filter) {
  const list = Array.isArray(nodes) ? nodes : [];
  if (filter === 'ssh') return list.filter(node => node.nodeKind === 'ssh_target');
  if (filter === 'all') return list;
  return list.filter(node => node.nodeKind === 'executor' && node.status === 'online');
}

export function countRegistryFilters(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  return {
    executors: list.filter(node => node.nodeKind === 'executor' && node.status === 'online').length,
    ssh: list.filter(node => node.nodeKind === 'ssh_target').length,
    all: list.length,
  };
}
