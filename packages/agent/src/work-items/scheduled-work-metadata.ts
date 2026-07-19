import type { WorkItemProjection } from './types.js';

export function readScheduledWorkMetadata(
  metadata: Record<string, unknown>,
): WorkItemProjection['scheduledWork'] {
  const value = metadata.scheduledWork;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.scheduleId !== 'string' || typeof record.runId !== 'string') return undefined;
  if (!['awaiting_approval', 'succeeded', 'failed'].includes(String(record.status))) return undefined;
  return {
    scheduleId: record.scheduleId,
    runId: record.runId,
    status: record.status as 'awaiting_approval' | 'succeeded' | 'failed',
    summary: record.summary && typeof record.summary === 'object' && !Array.isArray(record.summary)
      ? record.summary as Record<string, unknown>
      : {},
  };
}
