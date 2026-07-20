import type { WorkItemCloseoutReport, WorkItemResultReview } from './types.js';

export function readWorkItemResultReview(value: unknown): WorkItemResultReview | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const review = value as Record<string, unknown>;
  if (review.decision !== 'accepted' && review.decision !== 'revision_requested') return undefined;
  if (typeof review.actor !== 'string' || typeof review.reason !== 'string' || typeof review.decidedAt !== 'string') return undefined;
  return {
    decision: review.decision,
    actor: review.actor,
    reason: review.reason,
    decidedAt: review.decidedAt,
    closeoutReport: normalizeWorkItemCloseoutReport(review.closeoutReport as Partial<WorkItemCloseoutReport> | undefined),
  };
}

export function normalizeWorkItemCloseoutReport(
  value: Partial<WorkItemCloseoutReport> | undefined,
): WorkItemCloseoutReport {
  return {
    dirtyPaths: normalizeArray(value?.dirtyPaths ?? []),
    changeId: normalizeOptional(value?.changeId),
    bookmark: normalizeOptional(value?.bookmark),
    checks: normalizeArray(value?.checks ?? []),
    residualRisk: normalizeOptional(value?.residualRisk),
  };
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function normalizeArray(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}
