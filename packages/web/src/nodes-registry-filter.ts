export type RegistryNode = {
  nodeId: string;
  nodeKind: string;
  status: string;
};

export type NodeRegistryFilter = 'executors' | 'ssh' | 'all';
export const DEFAULT_NODE_REGISTRY_FILTER: NodeRegistryFilter = 'executors';

export function filterRegistryNodes<T extends Pick<RegistryNode, 'nodeKind' | 'status'>>(
  nodes: T[] | undefined,
  filter: string,
): T[] {
  const list = nodes ?? [];
  if (filter === 'ssh') return list.filter(node => node.nodeKind === 'ssh_target');
  if (filter === 'all') return list;
  return list.filter(node => node.nodeKind === 'executor' && node.status === 'online');
}

export function countRegistryFilters(nodes: Array<Pick<RegistryNode, 'nodeKind' | 'status'>> | undefined) {
  const list = nodes ?? [];
  return {
    executors: list.filter(node => node.nodeKind === 'executor' && node.status === 'online').length,
    ssh: list.filter(node => node.nodeKind === 'ssh_target').length,
    all: list.length,
  };
}
