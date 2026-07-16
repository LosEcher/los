import {
  listDeadLetterEvents,
} from './dead-letter.js';
import { requeueDeadLetterEvent, summarizeDeadLetterEvents, type DeadLetterSummary } from './dead-letter-recovery.js';

export interface DeadLetterGovernanceResult extends DeadLetterSummary, Record<string, unknown> {
  auditedAt: string;
  dryRun: boolean;
  candidateIds: string[];
  requeuedTaskRunIds: string[];
  skipped: Array<{ eventId: string; reason: string }>;
  errors: string[];
}

export async function runDeadLetterGovernance(options: {
  dryRun: boolean;
  limit?: number;
}): Promise<DeadLetterGovernanceResult> {
  const limit = normalizeLimit(options.limit);
  const summary = await summarizeDeadLetterEvents();
  const candidates = (await listDeadLetterEvents({ reason: 'lease_expired', acknowledged: false, limit }))
    .filter((event) => !event.requeuedTaskRunId);
  const candidateIds = candidates.map((event) => event.id);
  const requeuedTaskRunIds: string[] = [];
  const skipped: Array<{ eventId: string; reason: string }> = [];
  const errors: string[] = [];

  if (!options.dryRun) {
    for (const event of candidates) {
      try {
        const result = await requeueDeadLetterEvent(event.id);
        if (result.status === 'requeued') requeuedTaskRunIds.push(result.taskRunId);
        else skipped.push({ eventId: event.id, reason: result.reason });
      } catch (error) {
        errors.push(`${event.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return {
    ...summary,
    auditedAt: new Date().toISOString(),
    dryRun: options.dryRun,
    candidateIds,
    requeuedTaskRunIds,
    skipped,
    errors,
  };
}

function normalizeLimit(value: unknown): number {
  const parsed = Number(value ?? 25);
  if (!Number.isFinite(parsed) || parsed <= 0) return 25;
  return Math.max(1, Math.min(100, Math.floor(parsed)));
}
