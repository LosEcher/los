import type { WorkItemAttentionState, WorkItemProjection, TodoStatus } from '../api/index.js';

export function NextStepGuide({ item }: { item: WorkItemProjection }) {
  const guide = nextStepGuide(item.attentionState, item.nextAction, item.status);
  return <section className={`next-step-guide ${guide.tone}`} aria-live="polite">
    <div><span className="eyebrow">Current stage</span><strong>{guide.stage}</strong></div>
    <p><b>Why this is here:</b> {guide.why}</p>
    <p><b>What happens next:</b> {guide.next}</p>
  </section>;
}

function nextStepGuide(attention: WorkItemAttentionState, action: WorkItemProjection['nextAction'], status: TodoStatus) {
  if (attention === 'approval_required' || action === 'review_plan') return {
    stage: 'Plan ready for approval',
    why: 'LOS keeps the plan separate from execution so the declared scope and checks are visible before anything runs.',
    next: 'Approve the plan to resume the execution attempt.',
    tone: 'warn',
  };
  if (attention === 'verification_blocked' || action === 'inspect_verification') return {
    stage: 'Required checks need attention',
    why: 'A result is not complete until its persisted verification records pass or are explicitly reviewed.',
    next: 'Run the required checks, then review the evidence.',
    tone: 'warn',
  };
  if (attention === 'review_ready' || action === 'review_changes') return {
    stage: 'Result ready for your review',
    why: 'The agent has finished its attempt; only the operator can accept the evidence or request a revision.',
    next: 'Review the checks and diff, then accept the result or request a revision.',
    tone: 'ok',
  };
  if (attention === 'running') return {
    stage: 'Agent is working',
    why: 'LOS is recording the run, tools, and verification evidence so the result can be resumed and audited.',
    next: 'Wait for the run to finish; no approval action is needed right now.',
    tone: 'info',
  };
  if (status === 'done') return {
    stage: 'Work is closed',
    why: 'The operator accepted the recorded result and the work item is no longer actionable.',
    next: 'Open Run evidence if you need to inspect the history.',
    tone: 'ok',
  };
  return {
    stage: 'Ready to start',
    why: 'This work item has a goal but no active execution attempt yet.',
    next: 'Start in Chat to create the first persisted run.',
    tone: 'info',
  };
}

export function attentionLabel(state: WorkItemAttentionState): string {
  switch (state) {
    case 'approval_required': return 'Needs plan approval';
    case 'verification_blocked': return 'Checks need attention';
    case 'recovery_required': return 'Recovery needed';
    case 'review_ready': return 'Ready for result review';
    case 'running': return 'Running';
    case 'none': return 'No action needed';
    default: return 'Needs inspection';
  }
}

export function friendlyWorkError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('editable surfaces exceed')) return 'This plan cannot be approved: its writable scope is outside the work item scope. Review the declared scope below and revise the plan before approving.';
  if (message.includes('approved plan')) return 'This run is not ready for execution yet. A valid persisted plan must be approved first.';
  return message;
}
