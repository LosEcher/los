import type { RunContractMetadata } from '@los/agent';
import { matchesPlanApprovalCapability } from '@los/agent/work-items';

export type PlanApprovalCapabilityError = {
  statusCode: 400 | 409;
  payload: { error: string; message: string };
};

export function validatePlanApprovalCapability(
  body: Record<string, unknown>,
  runSpecId: string,
  contract: RunContractMetadata | undefined,
): PlanApprovalCapabilityError | undefined {
  const hasPlanRevision = Object.hasOwn(body, 'planRevision');
  const hasContractHash = Object.hasOwn(body, 'contractHash');
  if (hasPlanRevision !== hasContractHash) {
    return invalid('planRevision and contractHash must be provided together');
  }
  if (!hasPlanRevision) return undefined;

  const planRevision = body.planRevision;
  const contractHash = body.contractHash;
  if (
    typeof planRevision !== 'number'
    || !Number.isInteger(planRevision)
    || planRevision <= 0
    || typeof contractHash !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(contractHash)
  ) {
    return invalid('planRevision must be a positive integer and contractHash must be a sha256 hash');
  }
  if (!contract || !matchesPlanApprovalCapability(runSpecId, contract, { planRevision, contractHash })) {
    return {
      statusCode: 409,
      payload: {
        error: 'approval_capability_stale',
        message: 'The plan changed after this approval action was issued. Reload Work and review the current revision.',
      },
    };
  }
  return undefined;
}

function invalid(message: string): PlanApprovalCapabilityError {
  return { statusCode: 400, payload: { error: 'invalid_request', message } };
}
