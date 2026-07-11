import {
  readRunStateProjection,
  type RunSpecStatus,
  type RunStateAction,
} from '@los/agent';
import { transitionExecutionState } from '@los/agent/execution-store';
import { appendSessionEvent, type SessionEventRecord } from '@los/agent/session-events';
import { listRunSpecsForSession } from '@los/agent/run-specs';
import { loadResumeState } from './chat-session-helpers.js';
import type { SendEvent } from './chat-live-events.js';
import type { SessionRecord } from '@los/agent/session';

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
  sessionActiveTaskRunIds: string[];
  failedTaskRunIds: string[];
  failedVerificationRecordIds: string[];
  pendingVerificationRecordIds: string[];
  recoveryRecommendation: 'none' | 'resume' | 'retry' | 'cancel' | 'operator_attention';
  lastEventId: number | null;
}

export interface ChatResumeDispatchGuard {
  disposition: 'dispatch' | 'suppress';
  reason: 'no_active_task' | 'active_task_present';
  event: SessionEventRecord | null;
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
    sessionActiveTaskRunIds: resumeState.activeTaskRuns.flatMap(task =>
      typeof task.id === 'string' ? [task.id] : []),
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

export function sendChatResumeState(
  send: SendEvent,
  session: SessionRecord,
  prepared: Awaited<ReturnType<typeof prepareChatResumePlan>>,
): void {
  send('session.resumed', {
    sessionId: session.id,
    messageCount: session.messages.length,
    turnCount: session.turns.length,
    turnPreviews: session.turns.map(turn => ({
      loop: turn.loopCount,
      text: turn.text.slice(0, 100),
      tools: turn.toolCalls.map(toolCall => toolCall.function.name),
      hasReasoning: Boolean(turn.reasoningContent),
    })),
    lastTaskRun: prepared.resumeState.lastTaskRun ?? null,
    activeTaskRuns: prepared.resumeState.activeTaskRuns ?? [],
    lastEventId: prepared.resumeState.lastEventId ?? null,
    recentEventCount: prepared.resumeState.recentEventCount ?? 0,
    resumePlan: prepared.plan,
  });
  send('session.resume_state', {
    sessionId: session.id,
    tasks: prepared.resumeState.recentTaskRuns ?? [],
    recentEvents: prepared.resumeState.recentEvents ?? [],
  });
}

export async function applyChatResumeDispatchGuard(input: {
  plan: ChatResumePlan;
  planEventId: number;
  currentRunSpecId: string;
  requestId: string;
  traceId: string;
}): Promise<ChatResumeDispatchGuard> {
  if (input.plan.sessionActiveTaskRunIds.length === 0) {
    return { disposition: 'dispatch', reason: 'no_active_task', event: null };
  }
  const transition = await transitionExecutionState({
    entityType: 'run_spec',
    entityId: input.currentRunSpecId,
    to: 'blocked',
    reason: 'active_task_present',
    commandId: input.requestId,
    causationId: String(input.planEventId),
    correlationId: input.traceId,
    source: 'coordinator',
    eventType: 'run.resume_dispatch_suppressed',
  });
  return { disposition: 'suppress', reason: 'active_task_present', event: transition.event };
}
