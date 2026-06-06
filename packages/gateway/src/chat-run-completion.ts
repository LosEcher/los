import type { RunSpecStatus } from '@los/agent/run-specs';
import { updateRunSpecStatus } from '@los/agent/run-specs';
import type { VerificationRecord } from '@los/agent';
import { listVerificationRecordsForRunSpec } from '@los/agent';
import { appendSessionEvent } from '@los/agent/session-events';

export interface DirectRunCompletionDecision {
  status: Extract<RunSpecStatus, 'succeeded' | 'blocked'>;
  blockedVerificationRecordIds: string[];
}

export interface ApplyDirectRunCompletionStatusInput {
  runSpecId: string;
  sessionId: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  nodeId?: string;
  requestId?: string;
  traceId?: string;
  taskRunId: string;
}

export function resolveDirectRunCompletionDecision(
  verificationRecords: readonly Pick<VerificationRecord, 'id' | 'required' | 'status'>[],
): DirectRunCompletionDecision {
  const blockedVerificationRecordIds = verificationRecords
    .filter(record => record.required && record.status !== 'succeeded' && record.status !== 'skipped')
    .map(record => record.id);
  return {
    status: blockedVerificationRecordIds.length > 0 ? 'blocked' : 'succeeded',
    blockedVerificationRecordIds,
  };
}

export async function applyDirectRunCompletionStatus(
  input: ApplyDirectRunCompletionStatusInput,
): Promise<DirectRunCompletionDecision> {
  const verificationRecords = await listVerificationRecordsForRunSpec(input.runSpecId);
  const decision = resolveDirectRunCompletionDecision(verificationRecords);
  await updateRunSpecStatus(input.runSpecId, decision.status);
  if (decision.status === 'blocked') {
    await appendSessionEvent({
      sessionId: input.sessionId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      userId: input.userId,
      nodeId: input.nodeId,
      requestId: input.requestId,
      traceId: input.traceId,
      type: 'run.blocked',
      payload: {
        runSpecId: input.runSpecId,
        taskRunId: input.taskRunId,
        reason: 'required verification records are not satisfied',
        blockReason: 'verifier_required',
        blockedVerificationRecordIds: decision.blockedVerificationRecordIds,
      },
    });
  }
  return decision;
}
