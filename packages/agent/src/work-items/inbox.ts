import type {
  InboxEntry,
  OrphanRuntimeEvidence,
  WorkItemAttentionState,
  WorkItemProjection,
} from './types.js';

export function projectInboxEntries(
  workItems: WorkItemProjection[],
  orphans: OrphanRuntimeEvidence[],
  limit: number,
): InboxEntry[] {
  const workEntries = workItems
    .filter(item => item.attentionState !== 'none')
    .map<InboxEntry>(item => ({
      id: `work-item-${item.id}`,
      sourceKind: 'work_item',
      workItemId: item.id,
      title: item.title,
      projectId: item.projectId,
      sessionId: item.evidence.latestSessionId,
      runSpecId: item.evidence.latestRunSpecId,
      taskRunId: item.evidence.latestTaskRunId,
      source: item.source,
      connector: item.feedAnalysis ? {
        kind: 'feed_analysis',
        dispatchStatus: item.feedAnalysis.dispatchStatus,
        resultAvailable: item.feedAnalysis.resultAvailable,
        callbackStatus: item.feedAnalysis.callback.latestStatus,
      } : undefined,
      attentionState: item.attentionState,
      nextAction: item.nextAction,
      updatedAt: item.updatedAt,
    }));
  return [
    ...workEntries,
    ...orphans.map<InboxEntry>(item => ({
      ...item,
      nextAction: item.attentionState === 'recovery_required' ? 'recover' : 'inspect_run',
    })),
  ].sort(compareInboxEntries).slice(0, limit);
}

function compareInboxEntries(a: InboxEntry, b: InboxEntry): number {
  const rank: Record<WorkItemAttentionState, number> = {
    approval_required: 0,
    recovery_required: 1,
    verification_blocked: 2,
    review_ready: 3,
    running: 4,
    unknown: 5,
    none: 6,
  };
  return rank[a.attentionState] - rank[b.attentionState] || b.updatedAt.localeCompare(a.updatedAt);
}
