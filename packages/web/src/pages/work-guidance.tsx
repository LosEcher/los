import type { WorkItemAttentionState, WorkItemProjection, TodoStatus } from '../api/index.js';
import { tt } from '../i18n';

export type WorkGuideTone = 'info' | 'warn' | 'ok';

export type WorkGuide = {
  stage: string;
  why: string;
  next: string;
  tone: WorkGuideTone;
};

export type WorkOutcomeLine = {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'danger' | 'info';
};

export type WorkOutcome = WorkGuide & {
  lines: WorkOutcomeLine[];
};

export const WORK_DEBUG_STORAGE_KEY = 'los.work.debug';

export function readWorkDebugPreference(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    if (new URLSearchParams(window.location.search).get('debug') === '1') return true;
    return window.localStorage.getItem(WORK_DEBUG_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeWorkDebugPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(WORK_DEBUG_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    /* ignore quota / private mode */
  }
}

/** Decision-layer card: stage, result lines, why, next — no technical ids. */
export function OutcomeCard({ item }: { item: WorkItemProjection }) {
  const outcome = buildWorkOutcome(item);
  return (
    <section className={`outcome-card next-step-guide ${outcome.tone}`} aria-live="polite" data-testid="work-outcome-card">
      <div>
        <span className="eyebrow">{tt('work.outcome.stageEyebrow')}</span>
        <strong>{outcome.stage}</strong>
      </div>
      <div className="outcome-card-body">
        {outcome.lines.length > 0 ? (
          <ul className="outcome-lines" aria-label={tt('work.outcome.summaryAria')}>
            {outcome.lines.map(line => (
              <li key={`${line.label}-${line.value}`} className={line.tone ? `outcome-line ${line.tone}` : 'outcome-line'}>
                <span>{line.label}</span>
                <strong>{line.value}</strong>
              </li>
            ))}
          </ul>
        ) : null}
        <p><b>{tt('work.guide.whyLabel')}</b> {outcome.why}</p>
        <p><b>{tt('work.guide.nextLabel')}</b> {outcome.next}</p>
      </div>
    </section>
  );
}

/** @deprecated Prefer OutcomeCard — kept for call-site compatibility during transition. */
export function NextStepGuide({ item }: { item: WorkItemProjection }) {
  return <OutcomeCard item={item} />;
}

export function buildWorkOutcome(item: WorkItemProjection): WorkOutcome {
  const guide = nextStepGuide(item.attentionState, item.nextAction, item.status);
  return {
    ...guide,
    lines: buildOutcomeLines(item),
  };
}

export function nextStepGuide(
  attention: WorkItemAttentionState,
  action: WorkItemProjection['nextAction'],
  status: TodoStatus,
): WorkGuide {
  if (attention === 'approval_required' || action === 'review_plan') return {
    stage: tt('work.guide.planReady'),
    why: tt('work.guide.planReadyWhy'),
    next: tt('work.guide.planReadyNext'),
    tone: 'warn',
  };
  if (attention === 'verification_blocked' || action === 'inspect_verification') return {
    stage: tt('work.guide.checksAttention'),
    why: tt('work.guide.checksAttentionWhy'),
    next: tt('work.guide.checksAttentionNext'),
    tone: 'warn',
  };
  if (attention === 'review_ready' || action === 'review_changes') return {
    stage: tt('work.guide.reviewReady'),
    why: tt('work.guide.reviewReadyWhy'),
    next: tt('work.guide.reviewReadyNext'),
    tone: 'ok',
  };
  if (attention === 'recovery_required' || action === 'recover') return {
    stage: tt('work.guide.recovery'),
    why: tt('work.guide.recoveryWhy'),
    next: tt('work.guide.recoveryNext'),
    tone: 'warn',
  };
  if (attention === 'running') return {
    stage: tt('work.guide.running'),
    why: tt('work.guide.runningWhy'),
    next: tt('work.guide.runningNext'),
    tone: 'info',
  };
  if (status === 'done') return {
    stage: tt('work.guide.closed'),
    why: tt('work.guide.closedWhy'),
    next: tt('work.guide.closedNext'),
    tone: 'ok',
  };
  if (status === 'cancelled') return {
    stage: tt('work.guide.cancelled'),
    why: tt('work.guide.cancelledWhy'),
    next: tt('work.guide.cancelledNext'),
    tone: 'info',
  };
  return {
    stage: tt('work.guide.readyToStart'),
    why: tt('work.guide.readyToStartWhy'),
    next: tt('work.guide.readyToStartNext'),
    tone: 'info',
  };
}

export function buildOutcomeLines(item: WorkItemProjection): WorkOutcomeLine[] {
  const lines: WorkOutcomeLine[] = [];
  const checks = buildChecksLine(item);
  if (checks) lines.push(checks);
  const changes = buildChangesLine(item);
  if (changes) lines.push(changes);
  const run = buildRunStatusLine(item);
  if (run) lines.push(run);
  const feed = buildFeedLine(item);
  if (feed) lines.push(feed);
  return lines;
}

function buildChecksLine(item: WorkItemProjection): WorkOutcomeLine | null {
  const { verificationRequired, verificationSucceeded, verificationFailed, verificationPending, verificationSkipped } = item.evidence;
  if (verificationRequired === 0 && verificationSucceeded === 0 && verificationFailed === 0 && verificationPending === 0) {
    return null;
  }
  const parts: string[] = [];
  if (verificationSucceeded > 0) parts.push(tt('work.outcome.checksPassed', { n: verificationSucceeded }));
  if (verificationFailed > 0) parts.push(tt('work.outcome.checksFailed', { n: verificationFailed }));
  if (verificationPending > 0) parts.push(tt('work.outcome.checksPending', { n: verificationPending }));
  if (verificationSkipped > 0) parts.push(tt('work.outcome.checksSkipped', { n: verificationSkipped }));
  const tone = verificationFailed > 0 ? 'danger' : verificationPending > 0 ? 'warn' : 'ok';
  return {
    label: tt('work.outcome.checksLabel'),
    value: parts.length > 0 ? parts.join(tt('work.outcome.listSep')) : tt('work.outcome.checksNone'),
    tone,
  };
}

function buildChangesLine(item: WorkItemProjection): WorkOutcomeLine | null {
  const decision = item.changes.resultReview?.decision;
  if (decision === 'accepted') {
    return { label: tt('work.outcome.changesLabel'), value: tt('work.outcome.changesAccepted'), tone: 'ok' };
  }
  if (decision === 'revision_requested') {
    return { label: tt('work.outcome.changesLabel'), value: tt('work.outcome.changesRevision'), tone: 'warn' };
  }
  if (item.changes.hasReviewableDiff) {
    const n = item.changes.workspaces.length;
    return {
      label: tt('work.outcome.changesLabel'),
      value: n > 0 ? tt('work.outcome.changesReadyCount', { n }) : tt('work.outcome.changesReady'),
      tone: 'ok',
    };
  }
  if (item.changes.workspaces.some(ws => ws.status === 'active' || ws.status === 'backup_ready')) {
    return { label: tt('work.outcome.changesLabel'), value: tt('work.outcome.changesInProgress'), tone: 'info' };
  }
  return null;
}

function buildRunStatusLine(item: WorkItemProjection): WorkOutcomeLine | null {
  const status = item.evidence.taskRunStatus ?? item.evidence.runSpecStatus;
  if (!status) return null;
  return {
    label: tt('work.outcome.runLabel'),
    value: humanRunStatus(status),
    tone: runStatusTone(status),
  };
}

function buildFeedLine(item: WorkItemProjection): WorkOutcomeLine | null {
  if (!item.feedAnalysis) return null;
  if (item.feedAnalysis.errorCode) {
    return {
      label: tt('work.outcome.feedLabel'),
      value: tt('work.outcome.feedError'),
      tone: 'danger',
    };
  }
  if (item.feedAnalysis.resultAvailable) {
    return {
      label: tt('work.outcome.feedLabel'),
      value: tt('work.outcome.feedReady'),
      tone: 'ok',
    };
  }
  return {
    label: tt('work.outcome.feedLabel'),
    value: tt('work.outcome.feedPending'),
    tone: 'info',
  };
}

function humanRunStatus(status: string): string {
  switch (status) {
    case 'succeeded': return tt('work.outcome.runSucceeded');
    case 'failed': return tt('work.outcome.runFailed');
    case 'blocked': return tt('work.outcome.runBlocked');
    case 'cancelled': return tt('work.outcome.runCancelled');
    case 'running':
    case 'in_progress': return tt('work.outcome.runRunning');
    case 'queued':
    case 'pending': return tt('work.outcome.runQueued');
    case 'planning': return tt('work.outcome.runPlanning');
    case 'plan_approved': return tt('work.outcome.runPlanApproved');
    default: return status.replaceAll('_', ' ');
  }
}

function runStatusTone(status: string): WorkOutcomeLine['tone'] {
  if (status === 'succeeded' || status === 'plan_approved') return 'ok';
  if (status === 'failed' || status === 'cancelled') return 'danger';
  if (status === 'blocked') return 'warn';
  return 'info';
}

export function attentionLabel(state: WorkItemAttentionState): string {
  switch (state) {
    case 'approval_required': return tt('work.attention.approvalRequired');
    case 'verification_blocked': return tt('work.attention.verificationBlocked');
    case 'recovery_required': return tt('work.attention.recoveryRequired');
    case 'review_ready': return tt('work.attention.reviewReady');
    case 'running': return tt('work.attention.running');
    case 'none': return tt('work.attention.none');
    default: return tt('work.attention.inspect');
  }
}

export function friendlyWorkError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('editable surfaces exceed')) return tt('work.error.scopeExceeded');
  if (message.includes('approved plan')) return tt('work.error.noApprovedPlan');
  if (message.includes('approval_capability_stale') || message.includes('plan changed')) {
    return tt('work.error.staleApproval');
  }
  return message;
}

/** Which available action is the single primary CTA (decision layer). */
export function primaryActionKey(
  actions: WorkItemProjection['availableActions'],
): 'approvePlan' | 'startWork' | 'runVerification' | 'continueSession' | null {
  if (actions.approvePlan) return 'approvePlan';
  if (actions.startWork) return 'startWork';
  if (actions.runVerification) return 'runVerification';
  if (actions.continueSession) return 'continueSession';
  return null;
}
