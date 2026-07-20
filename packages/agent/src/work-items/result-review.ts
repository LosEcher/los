import { loadTodo, updateTodo } from '../todos.js';
import { loadWorkItemProjection } from './projection.js';
import { normalizeWorkItemCloseoutReport } from './result-review-metadata.js';
import type {
  ReviewWorkItemResultInput,
  WorkItemProjection,
  WorkItemResultReview,
} from './types.js';

class WorkItemReviewError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkItemReviewError';
  }
}

export function isWorkItemReviewError(error: unknown): error is Error & { code: string } {
  return error instanceof WorkItemReviewError;
}

export async function reviewWorkItemResult(input: ReviewWorkItemResultInput): Promise<WorkItemProjection> {
  const todo = await loadTodo(input.workItemId);
  if (!todo) throw new WorkItemReviewError('not_found', 'work item not found');
  const projection = await loadWorkItemProjection(todo.id);
  if (!projection) throw new WorkItemReviewError('not_found', 'work item projection not found');
  const reason = input.reason.trim();
  if (!reason) throw new WorkItemReviewError('reason_required', 'result decision reason is required');
  if (input.decision === 'accepted') _assertResultCanBeAccepted(projection);
  const review: WorkItemResultReview = {
    decision: input.decision,
    actor: input.actor.trim() || 'operator',
    reason,
    decidedAt: new Date().toISOString(),
    closeoutReport: normalizeWorkItemCloseoutReport(input.closeoutReport),
  };
  await updateTodo(todo.id, {
    status: input.decision === 'accepted' ? 'done' : 'in_progress',
    metadata: { ...todo.metadata, resultReview: review },
  });
  const updated = await loadWorkItemProjection(todo.id);
  if (!updated) throw new WorkItemReviewError('not_found', 'work item disappeared after result decision');
  return updated;
}

export function _assertResultCanBeAccepted(item: WorkItemProjection): void {
  if (item.evidence.runSpecStatus !== 'succeeded') {
    throw new WorkItemReviewError('run_not_succeeded', 'result acceptance requires a succeeded run spec');
  }
  if (item.runContractDraft.mode === 'execution' && item.evidence.verificationRequired === 0) {
    throw new WorkItemReviewError('verification_required', 'execution result requires verification evidence or an explicit allowed skip');
  }
  if (item.evidence.verificationFailed > 0 || item.evidence.verificationPending > 0) {
    throw new WorkItemReviewError('verification_incomplete', 'required verification is failed, pending, or missing');
  }
  const missingBackups = item.changes.workspaces.filter(workspace => (
    workspace.status !== 'failed' && !workspace.backupArtifactId
  ));
  if (missingBackups.length > 0) {
    throw new WorkItemReviewError('diff_backup_required', 'managed workspace diff backup is required before result acceptance');
  }
}
