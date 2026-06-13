import {
  editableSurfacesForAgentTask,
  editableSurfacesOverlap,
  type EditableSurfaceConflictMode,
} from '../agent-task-editable-surfaces.js';
import type { AgentTaskRecord } from '../agent-task-graph.js';
import { recordSchedulerDecision } from '../scheduler-decision-ledger.js';

export type ClaimDecisionContext = {
  graphId: string;
  nodeId?: string;
  limit: number;
  candidateLimit: number;
  mode: EditableSurfaceConflictMode;
  candidates: AgentTaskRecord[];
  runningTasks: AgentTaskRecord[];
  selected: AgentTaskRecord[];
};

export function describeClaimSkippedTasks(context: ClaimDecisionContext): Array<{ id: string; reason: string; details?: Record<string, unknown> }> {
  const selectedIds = new Set(context.selected.map(task => task.id));
  const occupied = context.runningTasks.flatMap(editableSurfacesForAgentTask);
  const skipped: Array<{ id: string; reason: string; details?: Record<string, unknown> }> = [];
  for (const task of context.candidates) {
    const surfaces = editableSurfacesForAgentTask(task);
    if (selectedIds.has(task.id)) {
      occupied.push(...surfaces);
      continue;
    }
    if (context.mode === 'require-declared' && surfaces.length === 0) {
      skipped.push({ id: task.id, reason: 'missing_editable_surface' });
      continue;
    }
    const conflict = surfaces.find(surface => occupied.some(existing => editableSurfacesOverlap(existing, surface)));
    if (conflict) {
      skipped.push({
        id: task.id,
        reason: 'editable_surface_conflict',
        details: { surface: conflict },
      });
      continue;
    }
    if (context.selected.length >= context.limit) {
      skipped.push({ id: task.id, reason: 'claim_limit_reached' });
    }
  }
  return skipped;
}

export async function recordClaimSchedulerDecision(context: ClaimDecisionContext): Promise<void> {
  await recordSchedulerDecision({
    graphId: context.graphId,
    nodeId: context.nodeId,
    kind: 'claim',
    selectedIds: context.selected.map(task => task.id),
    skipped: describeClaimSkippedTasks(context),
    reason: claimDecisionReason(context),
    metadata: {
      limit: context.limit,
      candidateLimit: context.candidateLimit,
      editableSurfaceMode: context.mode,
      candidateTaskIds: context.candidates.map(task => task.id),
      candidateSummaries: context.candidates.map(task => ({
        id: task.id,
        priority: task.priority,
        confidence: task.confidence,
        costEstimate: task.costEstimate,
        deadlineAt: task.deadlineAt,
      })),
      runningTaskIds: context.runningTasks.map(task => task.id),
    },
  });
}

function claimDecisionReason(context: ClaimDecisionContext): string {
  if (context.selected.length > 0) return 'ready_tasks_claimed';
  return context.candidates.length > 0 ? 'no_editable_surface_compatible_tasks' : 'no_ready_candidates';
}
