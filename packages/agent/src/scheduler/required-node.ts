import type { ExecutorNodeRecord } from '../executor-nodes.js';

/**
 * Why a hard-pinned node cannot be selected. Kept out of executor-client so the
 * placement file stays under the structure gate and the reason vocabulary is
 * testable in one place.
 */
export function _requiredNodeBlockReason(
  requiredNodeId: string,
  nodes: readonly ExecutorNodeRecord[],
  maintenanceBlocked: ReadonlySet<string>,
): string {
  const target = nodes.find(node => node.nodeId === requiredNodeId);
  if (!target) return 'required_node_not_registered';
  if (maintenanceBlocked.has(requiredNodeId)) return 'maintenance:window_active';
  return target.execution.blockers[0] ?? 'not_candidate';
}
