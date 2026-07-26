import { contentVersionHash } from '../distribution-version.js';
import type { RunContractMetadata } from '../run-contract.js';
import type {
  WorkItemAvailableActions,
  WorkItemNextAction,
} from './types.js';

function planApprovalCapabilityPayload(
  runSpecId: string,
  contract: RunContractMetadata,
): NonNullable<WorkItemAvailableActions['approvePlan']>['payload'] {
  return {
    runSpecId,
    planRevision: contract.planRevision ?? 1,
    contractHash: `sha256:${contentVersionHash(contract)}`,
  };
}

export function matchesPlanApprovalCapability(
  runSpecId: string,
  contract: RunContractMetadata,
  candidate: { planRevision: number; contractHash: string },
): boolean {
  const current = planApprovalCapabilityPayload(runSpecId, contract);
  return candidate.planRevision === current.planRevision
    && candidate.contractHash === current.contractHash;
}

export function projectWorkItemAvailableActions(input: {
  workItemId: string;
  nextAction: WorkItemNextAction;
  runSpecId?: string;
  sessionId?: string;
  contract: RunContractMetadata;
}): WorkItemAvailableActions {
  const actions: WorkItemAvailableActions = {};
  if (input.nextAction === 'start') {
    actions.startWork = action('Start in Chat', 'Create a planning attempt for this Work Item.', `work_item:${input.workItemId}`, {
      workItemId: input.workItemId,
    });
  }
  if (input.nextAction === 'review_plan' && input.runSpecId) {
    actions.approvePlan = action('Approve plan & allow execution', 'Approve the current persisted plan and schedule execution.', `run_spec:${input.runSpecId}`, planApprovalCapabilityPayload(input.runSpecId, input.contract));
  }
  if (input.nextAction === 'inspect_verification' && input.runSpecId) {
    actions.runVerification = action('Run required checks', 'Execute the persisted verification requirements.', `run_spec:${input.runSpecId}`, {
      runSpecId: input.runSpecId,
    });
  }
  if (input.runSpecId) {
    actions.inspectRun = action('Run evidence', 'Open persisted execution evidence without changing state.', `run_spec:${input.runSpecId}`, {
      runSpecId: input.runSpecId,
    });
  }
  if (input.sessionId) {
    actions.continueSession = action('Continue', 'Open the linked session without changing execution state.', `session:${input.sessionId}`, {
      sessionId: input.sessionId,
    });
  }
  if (input.nextAction === 'review_changes') {
    actions.reviewResult = action('Review result', 'Accept the verified result or request a revision.', `work_item:${input.workItemId}`, {
      workItemId: input.workItemId,
      decisions: ['accepted', 'revision_requested'],
    });
  }
  return actions;
}

function action<Payload>(
  label: string,
  effect: string,
  scope: string,
  payload: Payload,
): { label: string; effect: string; scope: string; irreversible: false; payload: Payload } {
  return { label, effect, scope, irreversible: false, payload };
}
