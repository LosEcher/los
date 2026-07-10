import {
  readRunStateProjection,
  type RunSpecStatus,
  type RunStateAction,
} from '@los/agent';
import { appendSessionEvent, type SessionEventRecord } from '@los/agent/session-events';
import { listRunSpecsForSession } from '@los/agent/run-specs';
import { loadResumeState } from './chat-session-helpers.js';

const RECOVERABLE_RUN_STATUSES = new Set<RunSpecStatus>([
  'created',
  'running',
  'blocked',
  'failed',
]);

export type ResumePlanSelectionReason =
  | 'latest_recoverable_run'
  | 'no_recoverable_run'
  | 'projection_unavailable';

export interface ChatResumePlan {
  currentRunSpecId: string;
  selectedRunSpecId: string | null;
  candidateRunSpecIds: string[];
  selectionReason: ResumePlanSelectionReason;
  phase: RunSpecStatus | null;
  action: RunStateAction;
  blockerKinds: string[];
  activeTaskRunIds: string[];
  failedTaskRunIds: string[];
  failedVerificationRecordIds: string[];
  pendingVerificationRecordIds: string[];
  recoveryRecommendation: 'none' | 'resume' | 'retry' | 'cancel' | 'operator_attention';
  lastEventId: number | null;
}

export async function prepareChatResumePlan(input: {
  sessionId: string;
  currentRunSpecId: string;
  tenantId: string;
  projectId: string;
  userId: string;
  requestId: string;
  traceId: string;
}): Promise<{
  resumeState: Awaited<ReturnType<typeof loadResumeState>>;
  plan: ChatResumePlan;
  event: SessionEventRecord;
}> {
  const [resumeState, runSpecs] = await Promise.all([
    loadResumeState(input.sessionId),
    listRunSpecsForSession(input.sessionId, 20),
  ]);
  const candidates = runSpecs.filter(runSpec =>
    runSpec.id !== input.currentRunSpecId && RECOVERABLE_RUN_STATUSES.has(runSpec.status));
  const selected = candidates[0];
  const projection = selected ? await readRunStateProjection(selected.id) : null;
  const selectionReason: ResumePlanSelectionReason = !selected
    ? 'no_recoverable_run'
    : projection ? 'latest_recoverable_run' : 'projection_unavailable';
  const plan: ChatResumePlan = {
    currentRunSpecId: input.currentRunSpecId,
    selectedRunSpecId: selected?.id ?? null,
    candidateRunSpecIds: candidates.map(runSpec => runSpec.id),
    selectionReason,
    phase: projection?.phase ?? selected?.status ?? null,
    action: projection?.action ?? (selected ? 'operator_attention' : 'none'),
    blockerKinds: projection?.blockers.map(blocker => blocker.kind) ?? [],
    activeTaskRunIds: projection?.ids.activeTaskRunIds ?? [],
    failedTaskRunIds: projection?.ids.failedTaskRunIds ?? [],
    failedVerificationRecordIds: projection?.ids.failedVerificationRecordIds ?? [],
    pendingVerificationRecordIds: projection?.ids.pendingVerificationRecordIds ?? [],
    recoveryRecommendation: projection?.recovery.recommendation ?? 'none',
    lastEventId: typeof resumeState.lastEventId === 'number' ? resumeState.lastEventId : null,
  };
  const event = await appendSessionEvent({
    sessionId: input.sessionId,
    tenantId: input.tenantId,
    projectId: input.projectId,
    userId: input.userId,
    requestId: input.requestId,
    traceId: input.traceId,
    type: 'coordinator.resume_plan_selected',
    source: 'coordinator',
    payload: { ...plan },
  });
  return { resumeState, plan, event };
}
