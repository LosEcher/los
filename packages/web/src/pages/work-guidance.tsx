import type { WorkItemAttentionState, WorkItemProjection, TodoStatus } from '../api/index.js';
import { tt } from '../i18n';

export function NextStepGuide({ item }: { item: WorkItemProjection }) {
  const guide = nextStepGuide(item.attentionState, item.nextAction, item.status);
  return <section className={`next-step-guide ${guide.tone}`} aria-live="polite">
    <div><span className="eyebrow">{tt('work.guide.stageEyebrow')}</span><strong>{guide.stage}</strong></div>
    <p><b>{tt('work.guide.whyLabel')}</b> {guide.why}</p>
    <p><b>{tt('work.guide.nextLabel')}</b> {guide.next}</p>
  </section>;
}

function nextStepGuide(attention: WorkItemAttentionState, action: WorkItemProjection['nextAction'], status: TodoStatus) {
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
  return {
    stage: tt('work.guide.readyToStart'),
    why: tt('work.guide.readyToStartWhy'),
    next: tt('work.guide.readyToStartNext'),
    tone: 'info',
  };
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
  return message;
}
